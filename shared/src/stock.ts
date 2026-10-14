import { z } from 'zod';
import { IsoDateTime, SentimentSchema } from './common';

export const STOCK_RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'MAX'] as const;
export const StockRangeSchema = z.enum(STOCK_RANGES);
export type StockRange = z.infer<typeof StockRangeSchema>;

/** OHLCV candle. `time` is UNIX seconds (UTC). Daily candles use 00:00 Asia/Jakarta of that date. */
export const CandleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});
export type Candle = z.infer<typeof CandleSchema>;

export const QuoteSchema = z.object({
  symbol: z.string(),
  price: z.number(),
  previousClose: z.number().nullable(),
  change: z.number().nullable(),
  changePercent: z.number().nullable(),
  dayHigh: z.number().nullable(),
  dayLow: z.number().nullable(),
  volume: z.number().nullable(),
  currency: z.string().nullable(),
  marketTime: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
  provider: z.string(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const StockHistoryResponseSchema = z.object({
  symbol: z.string(),
  range: StockRangeSchema,
  interval: z.enum(['15m', '1d', '1wk']),
  candles: z.array(CandleSchema),
  quote: QuoteSchema.nullable(),
  /** True when the last successful fetch is older than expected. */
  stale: z.boolean(),
  lastSuccessAt: IsoDateTime.nullable(),
  lastError: z.string().nullable(),
});
export type StockHistoryResponse = z.infer<typeof StockHistoryResponseSchema>;

/** Saved news plotted on the chart. */
export const StockMarkerSchema = z.object({
  articleId: z.string(),
  time: z.number(),
  sentiment: SentimentSchema,
  title: z.string(),
});
export type StockMarker = z.infer<typeof StockMarkerSchema>;

/** A trading day whose volume is far above its recent average. */
export const VolumeAnomalySchema = z.object({
  /** YYYY-MM-DD (Asia/Jakarta trading date). */
  date: z.string(),
  time: z.number(),
  volume: z.number(),
  averageVolume: z.number(),
  /** volume / average of the previous `window` trading days. */
  ratio: z.number(),
  close: z.number().nullable(),
  changePercent: z.number().nullable(),
  /** 'intraday' = flagged during the session from the running volume. */
  source: z.enum(['eod', 'intraday']),
  notifiedAt: IsoDateTime.nullable(),
});
export type VolumeAnomaly = z.infer<typeof VolumeAnomalySchema>;

export interface VolumeAnomalyOptions {
  /** Trading days in the baseline average (default 20). */
  window?: number;
  /** Minimum volume / average ratio to flag (default 2.5). */
  minRatio?: number;
  /** Days of history required before flagging (default 10). */
  minHistory?: number;
}

/** UTC-midnight daily candle time -> YYYY-MM-DD. */
export function candleDate(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

/** Average volume of the `window` candles before index `i` (zero-volume days ignored). */
export function trailingAverageVolume(daily: Candle[], i: number, window = 20): { average: number; count: number } {
  const prior = daily.slice(Math.max(0, i - window), i).filter((c) => c.volume > 0);
  if (!prior.length) return { average: 0, count: 0 };
  return { average: prior.reduce((s, c) => s + c.volume, 0) / prior.length, count: prior.length };
}

/**
 * Flag days whose volume is at least `minRatio` x the trailing average.
 * `daily` must be sorted by time ascending.
 */
export function detectVolumeAnomalies(daily: Candle[], opts: VolumeAnomalyOptions = {}): Omit<VolumeAnomaly, 'notifiedAt'>[] {
  const window = opts.window ?? 20;
  const minRatio = opts.minRatio ?? 2.5;
  const minHistory = opts.minHistory ?? 10;
  const out: Omit<VolumeAnomaly, 'notifiedAt'>[] = [];
  for (let i = 0; i < daily.length; i++) {
    const c = daily[i]!;
    const { average, count } = trailingAverageVolume(daily, i, window);
    if (count < minHistory || average <= 0) continue;
    const ratio = c.volume / average;
    if (ratio < minRatio) continue;
    const prev = daily[i - 1];
    out.push({
      date: candleDate(c.time),
      time: c.time,
      volume: c.volume,
      averageVolume: Math.round(average),
      ratio: Number(ratio.toFixed(2)),
      close: c.close,
      changePercent: prev ? Number((((c.close - prev.close) / prev.close) * 100).toFixed(2)) : null,
      source: 'eod',
    });
  }
  return out;
}
