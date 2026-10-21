import {
  AddAssetRequestSchema,
  dateInZone,
  detectVolumeAnomalies,
  MAX_ASSETS,
  StockExportIntervalSchema,
  StockRangeSchema,
  StockSymbolRequestSchema,
  stockCsv,
  SymbolSchema,
  type Settings,
  type StockAsset,
  type StockAssetsResponse,
  type StockHistoryResponse,
  type VolumeAnomaly,
} from '@bio-majesty/shared';
import { z } from 'zod';
import { invokeAsync } from '../../lib/aws';
import { env } from '../../lib/env';
import { badRequest, conflict, json, notFound, parseBody, parseQuery, pathParam, type AuthUser } from '../../lib/http';
import { errorMessage } from '../../lib/logger';
import { createRouter } from '../../lib/router';
import { addDays, addMonths, parseDateInput } from '../../lib/time';
import { getSettings, saveSettings } from '../../repo/settings';
import { getAsset, getAssets, getQuote, getStockStatus, listAnomalyRecords, putAsset, queryDaily, queryIntraday } from '../../repo/stock';
import { ANOMALY_WINDOW } from '../../stock/anomalies';
import { fallbackAsset, historyStart, INTRADAY_DOWNLOAD_DAYS, lastSession, planRange, stockProvider, toWeekly } from '../../stock';

/** Data is stale if the last successful refresh is older than this (covers weekends/holidays loosely). */
const STALE_AFTER_MS = 3 * 24 * 3600 * 1000;

const SymbolQuery = z.object({ symbol: SymbolSchema });

/** The caller's asset, or 404: an account only reads market data for the symbols it tracks. */
async function ownAsset(user: AuthUser, symbol: string): Promise<{ settings: Settings; asset: StockAsset }> {
  const settings = await getSettings(user.sub);
  if (!settings.stock.symbols.includes(symbol)) throw notFound(`${symbol} is not one of your assets`);
  return { settings, asset: (await getAsset(symbol)) ?? fallbackAsset(symbol) };
}

async function assetList(settings: Settings): Promise<StockAssetsResponse> {
  const known = new Map((await getAssets(settings.stock.symbols)).map((a) => [a.symbol, a]));
  return { items: settings.stock.symbols.map((s) => known.get(s) ?? fallbackAsset(s)) };
}

export const handler = createRouter({
  'GET /stock/assets': async (_event, user) => json(200, await assetList(await getSettings(user.sub))),

  /** Track another symbol: looked up on the market-data source first, then its history loads in the background. */
  'POST /stock/assets': async (event, user) => {
    const { symbol } = parseBody(event, AddAssetRequestSchema);
    const settings = await getSettings(user.sub);
    if (settings.stock.symbols.includes(symbol)) throw conflict(`${symbol} is already in your list`);
    if (settings.stock.symbols.length >= MAX_ASSETS) throw badRequest(`You can track up to ${MAX_ASSETS} assets; remove one first`);
    let asset = await getAsset(symbol);
    if (!asset) {
      try {
        asset = await stockProvider().lookup(symbol);
      } catch (err) {
        throw badRequest(`No market data found for ${symbol} (${errorMessage(err).slice(0, 200)}). Check the symbol on finance.yahoo.com.`);
      }
      await putAsset(asset);
    }
    const next = await saveSettings(user.sub, { ...settings, stock: { ...settings.stock, symbols: [...settings.stock.symbols, symbol] } });
    if (!(await getStockStatus(symbol)).historyLoadedAt) await invokeAsync(env.stockIngestFunction, { mode: 'resync', symbol });
    return json(201, await assetList(next));
  },

  'DELETE /stock/assets/{symbol}': async (event, user) => {
    const parsed = SymbolSchema.safeParse(pathParam(event, 'symbol'));
    if (!parsed.success) throw badRequest('Invalid symbol');
    const symbol = parsed.data;
    const settings = await getSettings(user.sub);
    if (!settings.stock.symbols.includes(symbol)) throw notFound(`${symbol} is not one of your assets`);
    if (settings.profile.sentimentSymbol === symbol) {
      throw badRequest(`Sentiment is judged against ${symbol}. Pick another asset (or the business outlook) in Settings → Profile first.`);
    }
    const next = await saveSettings(user.sub, {
      ...settings,
      stock: { ...settings.stock, symbols: settings.stock.symbols.filter((s) => s !== symbol) },
    });
    return json(200, await assetList(next));
  },

  'GET /stock/history': async (event, user) => {
    const { symbol, range } = parseQuery(event, SymbolQuery.extend({ range: StockRangeSchema.default('3M') }));
    const { asset } = await ownAsset(user, symbol);
    const now = new Date();
    const plan = planRange(range, now, historyStart(asset));
    let candles =
      plan.source === 'intraday' ? await queryIntraday(symbol, plan.from, now) : await queryDaily(symbol, plan.from, now, asset.timeZone);
    if (range === '1D') candles = lastSession(candles, asset.timeZone);
    if (plan.interval === '1wk') candles = toWeekly(candles);
    const [quote, status] = await Promise.all([getQuote(symbol), getStockStatus(symbol)]);
    const body: StockHistoryResponse = {
      symbol,
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
    const q = parseQuery(event, SymbolQuery.extend({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
    const { settings, asset } = await ownAsset(user, q.symbol);
    const { stock } = settings;
    const now = new Date();
    const from = q.from ? parseDateInput(q.from, false, asset.timeZone) : addMonths(now, -12);
    const fromDate = dateInZone(asset.timeZone, from);
    // Load extra history so the first days in range have a full baseline window.
    const daily = asset.hasVolume ? await queryDaily(q.symbol, addDays(from, -45), now, asset.timeZone) : [];
    const detected = detectVolumeAnomalies(daily, { window: ANOMALY_WINDOW, minRatio: stock.volumeRatio }).filter((a) => a.date >= fromDate);
    const records = await listAnomalyRecords(user.sub, q.symbol, fromDate);
    const byDate = new Map<string, VolumeAnomaly>(records.map((r) => [r.date, r]));
    const items: VolumeAnomaly[] = detected.map((a) => ({ ...a, notifiedAt: byDate.get(a.date)?.notifiedAt ?? null }));
    // Intraday flags for a session whose daily bar is not stored yet.
    for (const r of records) if (!items.some((i) => i.date === r.date)) items.push(r);
    items.sort((a, b) => b.date.localeCompare(a.date));
    return json(200, { items, minRatio: stock.volumeRatio, window: ANOMALY_WINDOW });
  },

  /**
   * CSV downloads, independent of the chart's range: every stored daily bar, or the intraday bars
   * the market-data source still has (fetched now: intraday bars are only kept for the charts).
   * About 46 bytes a row, far below the 6 MB Lambda response limit.
   */
  'GET /stock/export': async (event, user) => {
    const { symbol, interval } = parseQuery(event, SymbolQuery.extend({ interval: StockExportIntervalSchema }));
    const { asset } = await ownAsset(user, symbol);
    const now = new Date();
    if (interval === '1d') {
      const candles = await queryDaily(symbol, historyStart(asset), now, asset.timeZone);
      return json(200, stockCsv(symbol, '1d', candles, env.timeZone));
    }
    if (!asset.intradayInterval) throw badRequest(`There are no intraday prices for ${symbol}, only daily ones`);
    const { candles } = await stockProvider().intraday(symbol, addDays(now, -INTRADAY_DOWNLOAD_DAYS));
    return json(200, stockCsv(symbol, asset.intradayInterval, candles, env.timeZone));
  },

  'POST /stock/resync': async (event, user) => {
    const { symbol } = parseBody(event, StockSymbolRequestSchema);
    await ownAsset(user, symbol);
    await invokeAsync(env.stockIngestFunction, { mode: 'resync', symbol });
    return json(202, { started: true });
  },
});
