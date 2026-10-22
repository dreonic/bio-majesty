import { displaySymbol, parseAssetId, STOCK_SOURCE_INFO, type Settings, type StockAsset } from '@bio-majesty/shared';
import { listAccounts } from '../lib/accounts';
import { errorMessage, logger } from '../lib/logger';
import { addDays } from '../lib/time';
import { escapeHtml } from '../notify/telegram';
import { notifyAccount } from '../notify/notify';
import { getSettings } from '../repo/settings';
import {
  getAsset,
  getStockStatus,
  INTRADAY_RETENTION_DAYS,
  putAsset,
  putDailyCandles,
  putIntradayCandles,
  putQuote,
  putStockStatus,
} from '../repo/stock';
import { historyStart, stockProvider } from '../stock';
import { checkEodVolume, checkIntradayVolume } from '../stock/anomalies';
import type { StockProvider, StockSnapshot } from '../stock/provider';
import { refreshPlan } from '../stock/session';

const ALERT_AFTER_FAILURES = 3;
/** The end-of-day run re-fetches this many days of intraday bars, so a short outage leaves no gap. */
const INTRADAY_REFETCH_DAYS = 7;

/** An account that tracks an asset, with its settings (volume alert threshold and toggle). */
interface Tracker {
  sub: string;
  settings: Settings;
}

type Mode = 'intraday' | 'eod' | 'resync';

/** Every asset any account tracks (by ID), with the accounts tracking it. */
async function trackersByAsset(): Promise<Map<string, Tracker[]>> {
  const byAsset = new Map<string, Tracker[]>();
  for (const { sub } of await listAccounts()) {
    const settings = await getSettings(sub);
    for (const id of settings.stock.assets) byAsset.set(id, [...(byAsset.get(id) ?? []), { sub, settings }]);
  }
  return byAsset;
}

/**
 * Market-data refresh. Scheduled every 15 minutes for every asset any account tracks, each from
 * its own source:
 *  - intraday:   while the asset's session is open (delayed bars + quote; only the quote when the
 *                source's bars arrive after the close)
 *  - end of day: once per trading date, once the source has settled it (last two weeks of daily
 *                bars, last week of intraday bars)
 *  - resync:     the full daily history plus recent intraday bars (new assets, Settings → Resync)
 * Unusual volume is checked and alerted per account (each has its own threshold and Telegram chat).
 */
export async function handler(event: { mode?: 'tick' | 'resync'; asset?: string } = {}): Promise<{ refreshed: string[] }> {
  const now = new Date();
  const trackers = await trackersByAsset();
  if (event.mode === 'resync') {
    if (!event.asset) throw new Error('A resync needs an asset');
    await refresh(event.asset, 'resync', trackers.get(event.asset) ?? [], now);
    return { refreshed: [event.asset] };
  }
  const refreshed: string[] = [];
  for (const [id, accounts] of trackers) {
    try {
      if (await tick(id, accounts, now)) refreshed.push(id);
    } catch {
      // Recorded in the asset's status (and alerted after repeated failures); go on with the others.
    }
  }
  return { refreshed };
}

/** Refresh what is due for one asset; returns whether anything was fetched. */
async function tick(id: string, accounts: Tracker[], now: Date): Promise<boolean> {
  const [asset, status] = await Promise.all([getAsset(id), getStockStatus(id)]);
  // First time (or no metadata yet): load the full daily history before anything else.
  if (!asset || !status.historyLoadedAt) {
    await refresh(id, 'resync', accounts, now);
    return true;
  }
  const plan = refreshPlan(asset, status.eodDoneFor, now);
  if (plan.eodFor) await refresh(id, 'eod', accounts, now, plan.eodFor);
  if (plan.intraday) await refresh(id, 'intraday', accounts, now);
  return Boolean(plan.eodFor || plan.intraday);
}

async function refresh(id: string, mode: Mode, accounts: Tracker[], now: Date, eodFor?: string): Promise<void> {
  const parsed = parseAssetId(id);
  if (!parsed) throw new Error(`Invalid asset ID "${id}"`);
  const provider = stockProvider(parsed.source);
  const status = await getStockStatus(id);
  try {
    let asset = await getAsset(id);
    if (mode === 'resync' || !asset) {
      asset = await provider.lookup(parsed.symbol);
      await putAsset(asset);
    }
    let candles = 0;
    if (mode === 'intraday') {
      const snapshot = await sessionSnapshot(provider, asset, now);
      await putIntradayCandles(id, snapshot.candles);
      if (snapshot.quote) await putQuote(snapshot.quote);
      candles = snapshot.candles.length;
      for (const a of accounts) await checkIntradayVolume(a.sub, asset, snapshot.quote, a.settings, now);
    } else {
      const snapshot = await provider.daily(asset, mode === 'resync' ? historyStart(asset) : addDays(now, -15));
      await putDailyCandles(id, snapshot.candles);
      if (snapshot.quote) await putQuote(snapshot.quote);
      candles = snapshot.candles.length;
      for (const a of accounts) await checkEodVolume(a.sub, asset, a.settings, now);
      candles += await refillIntraday(provider, asset, addDays(now, mode === 'resync' ? -INTRADAY_RETENTION_DAYS : -INTRADAY_REFETCH_DAYS));
    }
    await putStockStatus(id, {
      lastSuccessAt: now.toISOString(),
      lastError: null,
      consecutiveFailures: 0,
      historyLoadedAt: mode === 'resync' ? now.toISOString() : status.historyLoadedAt,
      eodDoneFor: eodDoneAfter(mode, asset, status.eodDoneFor, now, eodFor),
    });
    logger.info('Stock data refreshed', { mode, asset: id, candles });
  } catch (err) {
    const message = errorMessage(err);
    const failures = status.consecutiveFailures + 1;
    await putStockStatus(id, { ...status, lastError: message, consecutiveFailures: failures });
    logger.error('Stock refresh failed', { mode, asset: id, error: message, failures });
    if (failures === ALERT_AFTER_FAILURES) {
      const source = STOCK_SOURCE_INFO[parsed.source].label;
      const text = `⚠️ <b>Stock data for ${escapeHtml(displaySymbol(id))} is not updating</b>\n${failures} failed refreshes in a row (${escapeHtml(source)}): ${escapeHtml(message.slice(0, 300))}`;
      for (const a of accounts) await notifyAccount(a.sub, text);
    }
    throw err;
  }
}

/**
 * What a refresh during the session fetches: the latest intraday bars and quote, or only the quote
 * when the source's intraday bars arrive after the close (the end-of-day run fetches them).
 */
async function sessionSnapshot(provider: StockProvider, asset: StockAsset, now: Date): Promise<StockSnapshot> {
  if (STOCK_SOURCE_INFO[asset.source].intraday === 'live') return provider.intraday(asset, addDays(now, -2));
  return { candles: [], quote: await provider.quote(asset) };
}

/** The trading date whose end-of-day pass is done after a refresh. */
function eodDoneAfter(mode: Mode, asset: StockAsset, before: string | null, now: Date, eodFor?: string): string | null {
  if (mode === 'eod') return eodFor ?? before;
  // A resync loads every closed session, so the end-of-day pass isn't due until the next one closes.
  if (mode === 'resync') return refreshPlan(asset, null, now).eodFor ?? before;
  return before;
}

/** Best effort: the daily refresh still counts as done if the intraday request fails (the intraday runs alert on that). */
async function refillIntraday(provider: StockProvider, asset: StockAsset, from: Date): Promise<number> {
  if (!asset.intradayInterval) return 0;
  try {
    const snapshot = await provider.intraday(asset, from);
    await putIntradayCandles(asset.id, snapshot.candles);
    return snapshot.candles.length;
  } catch (err) {
    logger.warn('Intraday refill failed', { asset: asset.id, from: from.toISOString(), error: errorMessage(err) });
    return 0;
  }
}
