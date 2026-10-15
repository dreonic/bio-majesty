import {
  MARKET_TIME_ZONE,
  StockRangeSchema,
  detectVolumeAnomalies,
  effectiveTags,
  type VolumeAnomaly,
  type StockHistoryResponse,
  type StockMarker,
} from '@bio-majesty/shared';
import { z } from 'zod';
import { invokeAsync } from '../../lib/aws';
import { env } from '../../lib/env';
import { json, parseQuery } from '../../lib/http';
import { createRouter } from '../../lib/router';
import { addDays, addMonths, jakartaDate, parseDateInput } from '../../lib/time';
import { listArticles } from '../../repo/articles';
import { getSettings } from '../../repo/settings';
import { getQuote, getStockStatus, listAnomalyRecords, queryDaily, queryIntraday } from '../../repo/stock';
import { ANOMALY_WINDOW } from '../../stock/anomalies';
import { dailyTime } from '../../stock/provider';
import { lastSession, planRange, toWeekly } from '../../stock';

/** Data is stale if the last successful refresh is older than this (covers weekends/holidays loosely). */
const STALE_AFTER_MS = 3 * 24 * 3600 * 1000;

export const handler = createRouter({
  'GET /stock/history': async (event) => {
    const { range } = parseQuery(event, z.object({ range: StockRangeSchema.default('3M') }));
    const { stock } = await getSettings();
    const now = new Date();
    const plan = planRange(range, now);
    let candles =
      plan.source === 'intraday'
        ? await queryIntraday(stock.symbol, plan.from, now)
        : await queryDaily(stock.symbol, plan.from, now);
    if (range === '1D') candles = lastSession(candles);
    if (plan.interval === '1wk') candles = toWeekly(candles);
    const [quote, status] = await Promise.all([getQuote(stock.symbol), getStockStatus(stock.symbol)]);
    const body: StockHistoryResponse = {
      symbol: stock.symbol,
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

  'GET /stock/markers': async (event) => {
    // `from`/`to` are trading dates (the chart's days), so they are read as Jakarta days.
    const q = parseQuery(event, z.object({ from: z.string(), to: z.string().optional() }));
    const { items } = await listArticles({
      status: 'APPROVED',
      from: parseDateInput(q.from, false, MARKET_TIME_ZONE),
      to: q.to ? parseDateInput(q.to, true, MARKET_TIME_ZONE) : undefined,
      limit: 300,
    });
    const markers: StockMarker[] = items.map((a) => ({
      articleId: a.id,
      time: dailyTime(new Date(a.publishedAt)),
      sentiment: effectiveTags(a).sentiment,
      title: a.title,
    }));
    return json(200, { items: markers.sort((a, b) => a.time - b.time) });
  },

  'GET /stock/anomalies': async (event) => {
    const { months } = parseQuery(event, z.object({ months: z.coerce.number().int().min(1).max(60).default(12) }));
    const { stock } = await getSettings();
    const now = new Date();
    const from = addMonths(now, -months);
    // Load extra history so the first days in range have a full baseline window.
    const daily = await queryDaily(stock.symbol, addDays(from, -45), now);
    const detected = detectVolumeAnomalies(daily, { window: ANOMALY_WINDOW, minRatio: stock.volumeRatio }).filter(
      (a) => a.time >= from.getTime() / 1000,
    );
    const records = await listAnomalyRecords(stock.symbol, jakartaDate(from));
    const byDate = new Map<string, VolumeAnomaly>(records.map((r) => [r.date, r]));
    const items: VolumeAnomaly[] = detected.map((a) => ({ ...a, notifiedAt: byDate.get(a.date)?.notifiedAt ?? null }));
    // Intraday flags for a session whose daily bar is not stored yet.
    for (const r of records) if (!items.some((i) => i.date === r.date)) items.push(r);
    items.sort((a, b) => b.date.localeCompare(a.date));
    return json(200, { items: items.slice(0, 100), minRatio: stock.volumeRatio, window: ANOMALY_WINDOW });
  },

  'POST /stock/resync': async () => {
    await invokeAsync(env.stockIngestFunction, { mode: 'resync' });
    await invokeAsync(env.stockIngestFunction, { mode: 'intraday' });
    return json(202, { started: true });
  },
});
