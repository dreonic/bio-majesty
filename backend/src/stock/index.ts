import type { Candle, StockRange } from '@bio-majesty/shared';
import { env } from '../lib/env';
import { addDays, addMonths } from '../lib/time';
import { EodhdStockProvider } from './eodhd';
import type { StockProvider } from './provider';
import { YahooStockProvider } from './yahoo';

let provider: StockProvider | undefined;

export function stockProvider(): StockProvider {
  provider ??= env.stockProvider === 'eodhd' ? new EodhdStockProvider() : new YahooStockProvider();
  return provider;
}

/** PRDA listed on IDX in December 2016. */
export const HISTORY_START = new Date('2016-12-01T00:00:00Z');

export interface RangePlan {
  source: 'intraday' | 'daily';
  interval: '15m' | '1d' | '1wk';
  from: Date;
}

export function planRange(range: StockRange, now = new Date()): RangePlan {
  switch (range) {
    case '1D':
      return { source: 'intraday', interval: '15m', from: addDays(now, -4) };
    case '5D':
      return { source: 'intraday', interval: '15m', from: addDays(now, -8) };
    case '1M':
      return { source: 'daily', interval: '1d', from: addMonths(now, -1) };
    case '3M':
      return { source: 'daily', interval: '1d', from: addMonths(now, -3) };
    case '6M':
      return { source: 'daily', interval: '1d', from: addMonths(now, -6) };
    case '1Y':
      return { source: 'daily', interval: '1d', from: addMonths(now, -12) };
    case '5Y':
      return { source: 'daily', interval: '1wk', from: addMonths(now, -60) };
    case 'MAX':
      return { source: 'daily', interval: '1wk', from: HISTORY_START };
  }
}

/** Keep only the most recent trading session (for the 1D view). */
export function lastSession(candles: Candle[]): Candle[] {
  if (!candles.length) return candles;
  const dayOf = (t: number) => new Date((t + 7 * 3600) * 1000).toISOString().slice(0, 10);
  const lastDay = dayOf(candles[candles.length - 1]!.time);
  return candles.filter((c) => dayOf(c.time) === lastDay);
}

/** Aggregate daily candles into weeks starting Monday (times stay at 00:00 UTC). */
export function toWeekly(daily: Candle[]): Candle[] {
  const weeks = new Map<number, Candle>();
  for (const c of daily) {
    const d = new Date(c.time * 1000);
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) / 1000;
    const cur = weeks.get(monday);
    if (!cur) weeks.set(monday, { ...c, time: monday });
    else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  return [...weeks.values()].sort((a, b) => a.time - b.time);
}
