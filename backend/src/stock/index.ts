import { dateInZone, MARKET_TIME_ZONE, type Candle, type StockAsset, type StockRange } from '@bio-majesty/shared';
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

/** Yahoo serves intraday bars for the last 60 days: what the intraday CSV download asks for. */
export const INTRADAY_DOWNLOAD_DAYS = 59;

/** Where an asset's daily history starts (the source's first trade date when known). */
export function historyStart(asset: Pick<StockAsset, 'firstTradeDate'>): Date {
  return asset.firstTradeDate ? new Date(asset.firstTradeDate) : new Date('1970-01-01T00:00:00Z');
}

/**
 * Metadata to work with before the source has been asked (e.g. an asset kept from before
 * metadata existed); the next refresh replaces it.
 */
export function fallbackAsset(symbol: string): StockAsset {
  const idx = symbol.endsWith('.JK');
  return {
    symbol,
    name: null,
    exchange: idx ? 'Jakarta' : null,
    type: null,
    currency: idx ? 'IDR' : null,
    timeZone: idx ? MARKET_TIME_ZONE : 'UTC',
    session: idx ? { start: '09:00', end: '16:15', days: 'weekdays' } : { start: '00:00', end: '23:59', days: 'weekdays' },
    intradayInterval: '15m',
    decimals: idx ? 0 : 2,
    hasVolume: true,
    firstTradeDate: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export interface RangePlan {
  source: 'intraday' | 'daily';
  interval: '15m' | '1d' | '1wk';
  from: Date;
}

export function planRange(range: StockRange, now: Date, historyFrom: Date): RangePlan {
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
      return { source: 'daily', interval: '1wk', from: historyFrom };
  }
}

/** Keep only the most recent trading session (for the 1D view), by trading date in `timeZone`. */
export function lastSession(candles: Candle[], timeZone: string): Candle[] {
  if (!candles.length) return candles;
  const dayOf = (t: number) => dateInZone(timeZone, new Date(t * 1000));
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
