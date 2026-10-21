import type { Settings, StockAsset } from '@bio-majesty/shared';
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
import { refreshPlan } from '../stock/session';

const ALERT_AFTER_FAILURES = 3;
/** The end-of-day run re-fetches this many days of intraday bars, so a short outage leaves no gap. */
const INTRADAY_REFETCH_DAYS = 7;

/** An account that tracks a symbol, with its settings (volume alert threshold and toggle). */
interface Tracker {
  sub: string;
  settings: Settings;
}

type Mode = 'intraday' | 'eod' | 'resync';

/** Every symbol any account tracks, with the accounts tracking it. */
async function trackersBySymbol(): Promise<Map<string, Tracker[]>> {
  const bySymbol = new Map<string, Tracker[]>();
  for (const { sub } of await listAccounts()) {
    const settings = await getSettings(sub);
    for (const symbol of settings.stock.symbols) bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), { sub, settings }]);
  }
  return bySymbol;
}

/**
 * Market-data refresh. Scheduled every 15 minutes for every symbol any account tracks:
 *  - intraday:   while the asset's session is open (delayed bars + quote)
 *  - end of day: once per trading date after the close (last two weeks of daily bars, last week of intraday bars)
 *  - resync:     the full daily history plus recent intraday bars (new assets, Settings → Resync)
 * Unusual volume is checked and alerted per account (each has its own threshold and Telegram chat).
 */
export async function handler(event: { mode?: 'tick' | 'resync'; symbol?: string } = {}): Promise<{ refreshed: string[] }> {
  const now = new Date();
  const trackers = await trackersBySymbol();
  if (event.mode === 'resync') {
    if (!event.symbol) throw new Error('A resync needs a symbol');
    await refresh(event.symbol, 'resync', trackers.get(event.symbol) ?? [], now);
    return { refreshed: [event.symbol] };
  }
  const refreshed: string[] = [];
  for (const [symbol, accounts] of trackers) {
    try {
      if (await tick(symbol, accounts, now)) refreshed.push(symbol);
    } catch {
      // Recorded in the symbol's status (and alerted after repeated failures); go on with the others.
    }
  }
  return { refreshed };
}

/** Refresh what is due for one symbol; returns whether anything was fetched. */
async function tick(symbol: string, accounts: Tracker[], now: Date): Promise<boolean> {
  const [asset, status] = await Promise.all([getAsset(symbol), getStockStatus(symbol)]);
  // First time (or no metadata yet): load the full daily history before anything else.
  if (!asset || !status.historyLoadedAt) {
    await refresh(symbol, 'resync', accounts, now);
    return true;
  }
  const plan = refreshPlan(asset, status.eodDoneFor, now);
  if (plan.eodFor) await refresh(symbol, 'eod', accounts, now, plan.eodFor);
  if (plan.intraday) await refresh(symbol, 'intraday', accounts, now);
  return Boolean(plan.eodFor || plan.intraday);
}

async function refresh(symbol: string, mode: Mode, accounts: Tracker[], now: Date, eodFor?: string): Promise<void> {
  const provider = stockProvider();
  const status = await getStockStatus(symbol);
  try {
    let asset = await getAsset(symbol);
    if (mode === 'resync' || !asset) {
      asset = await provider.lookup(symbol);
      await putAsset(asset);
    }
    let candles = 0;
    if (mode === 'intraday') {
      const snapshot = await provider.intraday(symbol, addDays(now, -2));
      await putIntradayCandles(symbol, snapshot.candles);
      if (snapshot.quote) await putQuote(snapshot.quote);
      candles = snapshot.candles.length;
      for (const a of accounts) await checkIntradayVolume(a.sub, asset, snapshot.quote, a.settings, now);
    } else {
      const snapshot = await provider.daily(asset, mode === 'resync' ? historyStart(asset) : addDays(now, -15));
      await putDailyCandles(symbol, snapshot.candles);
      if (snapshot.quote) await putQuote(snapshot.quote);
      candles = snapshot.candles.length;
      for (const a of accounts) await checkEodVolume(a.sub, asset, a.settings, now);
      candles += await refillIntraday(asset, addDays(now, mode === 'resync' ? -INTRADAY_RETENTION_DAYS : -INTRADAY_REFETCH_DAYS));
    }
    await putStockStatus(symbol, {
      lastSuccessAt: now.toISOString(),
      lastError: null,
      consecutiveFailures: 0,
      historyLoadedAt: mode === 'resync' ? now.toISOString() : status.historyLoadedAt,
      eodDoneFor: eodDoneAfter(mode, asset, status.eodDoneFor, now, eodFor),
    });
    logger.info('Stock data refreshed', { mode, symbol, provider: provider.name, candles });
  } catch (err) {
    const message = errorMessage(err);
    const failures = status.consecutiveFailures + 1;
    await putStockStatus(symbol, { ...status, lastError: message, consecutiveFailures: failures });
    logger.error('Stock refresh failed', { mode, symbol, provider: provider.name, error: message, failures });
    if (failures === ALERT_AFTER_FAILURES) {
      const text = `⚠️ <b>Stock data for ${escapeHtml(symbol)} is not updating</b>\n${failures} failed refreshes in a row (${escapeHtml(provider.name)}): ${escapeHtml(message.slice(0, 300))}`;
      for (const a of accounts) await notifyAccount(a.sub, text);
    }
    throw err;
  }
}

/** The trading date whose end-of-day pass is done after a refresh. */
function eodDoneAfter(mode: Mode, asset: StockAsset, before: string | null, now: Date, eodFor?: string): string | null {
  if (mode === 'eod') return eodFor ?? before;
  // A resync loads every closed session, so the end-of-day pass isn't due until the next one closes.
  if (mode === 'resync') return refreshPlan(asset, null, now).eodFor ?? before;
  return before;
}

/** Best effort: the daily refresh still counts as done if the intraday request fails (the intraday runs alert on that). */
async function refillIntraday(asset: StockAsset, from: Date): Promise<number> {
  if (!asset.intradayInterval) return 0;
  try {
    const snapshot = await stockProvider().intraday(asset.symbol, from);
    await putIntradayCandles(asset.symbol, snapshot.candles);
    return snapshot.candles.length;
  } catch (err) {
    logger.warn('Intraday refill failed', { symbol: asset.symbol, from: from.toISOString(), error: errorMessage(err) });
    return 0;
  }
}
