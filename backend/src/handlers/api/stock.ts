import {
  AddAssetRequestSchema,
  AssetIdSchema,
  assetId,
  dateInZone,
  detectVolumeAnomalies,
  MAX_ASSETS,
  STOCK_SOURCE_INFO,
  StockAssetRequestSchema,
  StockExportIntervalSchema,
  StockRangeSchema,
  StockSearchQuerySchema,
  stockCsv,
  type Settings,
  type StockAsset,
  type StockAssetsResponse,
  type StockHistoryResponse,
  type StockSearchResponse,
  type StockSource,
  type VolumeAnomaly,
} from '@bio-majesty/shared';
import { z } from 'zod';
import { invokeAsync } from '../../lib/aws';
import { env } from '../../lib/env';
import { badRequest, conflict, HttpError, json, notFound, parseBody, parseQuery, type AuthUser } from '../../lib/http';
import { errorMessage } from '../../lib/logger';
import { createRouter } from '../../lib/router';
import { addDays, addMonths, parseDateInput } from '../../lib/time';
import { getSettings, saveSettings } from '../../repo/settings';
import { getAsset, getAssets, getQuote, getStockStatus, listAnomalyRecords, putAsset, queryDaily, queryIntraday } from '../../repo/stock';
import { ANOMALY_WINDOW } from '../../stock/anomalies';
import {
  configuredSources,
  fallbackAsset,
  historyStart,
  intradayDownloadFrom,
  lastSession,
  planRange,
  SOURCE_SECRET_KEYS,
  stockProvider,
  toWeekly,
} from '../../stock';
import type { StockProvider } from '../../stock/provider';

/** Data is stale if the last successful refresh is older than this (covers weekends/holidays loosely). */
const STALE_AFTER_MS = 3 * 24 * 3600 * 1000;
/** Closest matches named when a symbol is not found. */
const SUGGESTIONS = 3;

const AssetQuery = z.object({ asset: AssetIdSchema });

/** The caller's asset, or 404: an account only reads market data for the assets it tracks. */
async function ownAsset(user: AuthUser, id: string): Promise<{ settings: Settings; asset: StockAsset }> {
  const settings = await getSettings(user.sub);
  if (!settings.stock.assets.includes(id)) throw notFound(`${id} is not one of your assets`);
  return { settings, asset: (await getAsset(id)) ?? fallbackAsset(id) };
}

async function assetList(settings: Settings): Promise<StockAssetsResponse> {
  const [known, sources] = await Promise.all([getAssets(settings.stock.assets), configuredSources()]);
  const byId = new Map(known.map((a) => [a.id, a]));
  return { items: settings.stock.assets.map((id) => byId.get(id) ?? fallbackAsset(id)), sources };
}

/** A source this deployment can use (its API key is in the API keys parameter), or 400. */
async function usableSource(source: StockSource): Promise<StockProvider> {
  if (!(await configuredSources()).includes(source)) {
    throw badRequest(`${STOCK_SOURCE_INFO[source].label} is not set up: add ${SOURCE_SECRET_KEYS[source]} to the API keys parameter first`);
  }
  return stockProvider(source);
}

/** Why a symbol could not be added, with the source's closest matches when it has any. */
async function lookupFailure(provider: StockProvider, symbol: string, err: unknown): Promise<string> {
  const { label, site } = STOCK_SOURCE_INFO[provider.source];
  const matches = (await provider.search(symbol).catch(() => [])).filter((m) => m.symbol !== symbol).slice(0, SUGGESTIONS);
  const hint = matches.length
    ? ` Did you mean ${matches.map((m) => (m.name ? `${m.symbol} (${m.name})` : m.symbol)).join(', ')}?`
    : ` Check the symbol on ${site}.`;
  return `No ${label} data for ${symbol} (${errorMessage(err).slice(0, 200)}).${hint}`;
}

export const handler = createRouter({
  'GET /stock/assets': async (_event, user) => json(200, await assetList(await getSettings(user.sub))),

  /** Track another asset: looked up on its source first, then its history loads in the background. */
  'POST /stock/assets': async (event, user) => {
    const { source, symbol } = parseBody(event, AddAssetRequestSchema);
    const id = assetId(source, symbol);
    const settings = await getSettings(user.sub);
    if (settings.stock.assets.includes(id)) throw conflict(`${symbol} from ${STOCK_SOURCE_INFO[source].label} is already in your list`);
    if (settings.stock.assets.length >= MAX_ASSETS) throw badRequest(`You can track up to ${MAX_ASSETS} assets; remove one first`);
    const provider = await usableSource(source);
    let asset = await getAsset(id);
    if (!asset) {
      try {
        asset = await provider.lookup(symbol);
      } catch (err) {
        throw badRequest(await lookupFailure(provider, symbol, err));
      }
      await putAsset(asset);
    }
    const next = await saveSettings(user.sub, { ...settings, stock: { ...settings.stock, assets: [...settings.stock.assets, id] } });
    if (!(await getStockStatus(id)).historyLoadedAt) await invokeAsync(env.stockIngestFunction, { mode: 'resync', asset: id });
    return json(201, await assetList(next));
  },

  // Like the other stock routes, the asset ID goes in the query string.
  'DELETE /stock/assets': async (event, user) => {
    const { asset: id } = parseQuery(event, AssetQuery);
    const settings = await getSettings(user.sub);
    if (!settings.stock.assets.includes(id)) throw notFound(`${id} is not one of your assets`);
    if (settings.subject.sentimentAsset === id) {
      throw badRequest(`Sentiment is judged against ${id}. Pick another asset (or the subject itself) in Settings → Subject first.`);
    }
    const next = await saveSettings(user.sub, {
      ...settings,
      stock: { ...settings.stock, assets: settings.stock.assets.filter((a) => a !== id) },
    });
    return json(200, await assetList(next));
  },

  /** Symbols a source suggests for a name or ticker (the Add form's search). */
  'GET /stock/search': async (event) => {
    const { source, q } = parseQuery(event, StockSearchQuerySchema);
    const provider = await usableSource(source);
    try {
      const body: StockSearchResponse = { items: await provider.search(q) };
      return json(200, body);
    } catch (err) {
      throw new HttpError(502, 'bad_gateway', `${STOCK_SOURCE_INFO[source].label} search failed: ${errorMessage(err).slice(0, 200)}`);
    }
  },

  'GET /stock/history': async (event, user) => {
    const { asset: id, range } = parseQuery(event, AssetQuery.extend({ range: StockRangeSchema.default('3M') }));
    const { asset } = await ownAsset(user, id);
    const now = new Date();
    const plan = planRange(range, now, historyStart(asset));
    let candles = plan.source === 'intraday' ? await queryIntraday(id, plan.from, now) : await queryDaily(id, plan.from, now, asset.timeZone);
    if (range === '1D') candles = lastSession(candles, asset.timeZone);
    if (plan.interval === '1wk') candles = toWeekly(candles);
    const [quote, status] = await Promise.all([getQuote(id), getStockStatus(id)]);
    const body: StockHistoryResponse = {
      asset: id,
      range,
      interval: plan.interval,
      candles,
      quote,
      stale: !status.lastSuccessAt || now.getTime() - new Date(status.lastSuccessAt).getTime() > STALE_AFTER_MS,
      lastSuccessAt: status.lastSuccessAt,
      lastError: status.lastError,
    };
    return json(200, body);
  },

  'GET /stock/anomalies': async (event, user) => {
    // `from` is a trading date (the chart's first day, so the list follows the selected range); default 12 months.
    const q = parseQuery(event, AssetQuery.extend({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
    const { settings, asset } = await ownAsset(user, q.asset);
    const { stock } = settings;
    const now = new Date();
    const from = q.from ? parseDateInput(q.from, false, asset.timeZone) : addMonths(now, -12);
    const fromDate = dateInZone(asset.timeZone, from);
    // Load extra history so the first days in range have a full baseline window.
    const daily = asset.hasVolume ? await queryDaily(q.asset, addDays(from, -45), now, asset.timeZone) : [];
    const detected = detectVolumeAnomalies(daily, { window: ANOMALY_WINDOW, minRatio: stock.volumeRatio }).filter((a) => a.date >= fromDate);
    const records = await listAnomalyRecords(user.sub, q.asset, fromDate);
    const byDate = new Map<string, VolumeAnomaly>(records.map((r) => [r.date, r]));
    const items: VolumeAnomaly[] = detected.map((a) => ({ ...a, notifiedAt: byDate.get(a.date)?.notifiedAt ?? null }));
    // Intraday flags for a session whose daily bar is not stored yet.
    for (const r of records) if (!items.some((i) => i.date === r.date)) items.push(r);
    items.sort((a, b) => b.date.localeCompare(a.date));
    return json(200, { items, minRatio: stock.volumeRatio, window: ANOMALY_WINDOW });
  },

  /**
   * CSV downloads, independent of the chart's range: every stored daily bar, or the intraday bars
   * the asset's source still has (fetched now: intraday bars are only kept for the charts).
   * About 46 bytes a row, far below the 6 MB Lambda response limit.
   */
  'GET /stock/export': async (event, user) => {
    const { asset: id, interval } = parseQuery(event, AssetQuery.extend({ interval: StockExportIntervalSchema }));
    const { asset } = await ownAsset(user, id);
    const now = new Date();
    if (interval === '1d') {
      const candles = await queryDaily(id, historyStart(asset), now, asset.timeZone);
      return json(200, stockCsv(asset.symbol, '1d', candles, env.timeZone));
    }
    if (!asset.intradayInterval) throw badRequest(`There are no intraday prices for ${asset.symbol}, only daily ones`);
    const { candles } = await stockProvider(asset.source).intraday(asset, intradayDownloadFrom(asset, now));
    return json(200, stockCsv(asset.symbol, asset.intradayInterval, candles, env.timeZone));
  },

  'POST /stock/resync': async (event, user) => {
    const { asset } = parseBody(event, StockAssetRequestSchema);
    await ownAsset(user, asset);
    await invokeAsync(env.stockIngestFunction, { mode: 'resync', asset });
    return json(202, { started: true });
  },
});
