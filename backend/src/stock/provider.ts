import type { Candle, Quote } from '@bio-majesty/shared';

export interface StockSnapshot {
  candles: Candle[];
  quote: Quote | null;
}

/**
 * Market-data source. Yahoo (free, unofficial) is the default; EODHD is the
 * documented paid alternative. Select with the `stockProvider` CDK context.
 */
export interface StockProvider {
  readonly name: string;
  /** Daily candles; `time` is normalized to 00:00 UTC of the Asia/Jakarta trading date. */
  daily(symbol: string, from: Date, to?: Date): Promise<StockSnapshot>;
  /** ~15-minute candles (delayed); `time` is the bar's real UNIX timestamp. */
  intraday(symbol: string, from: Date): Promise<StockSnapshot>;
}

/** Normalize a bar timestamp to 00:00 UTC of its Asia/Jakarta date (stable daily x-axis). */
export function dailyTime(date: Date): number {
  const jakarta = new Date(date.getTime() + 7 * 3600 * 1000);
  return Date.UTC(jakarta.getUTCFullYear(), jakarta.getUTCMonth(), jakarta.getUTCDate()) / 1000;
}

export function isValidCandle(c: Partial<Candle>): c is Candle {
  return [c.open, c.high, c.low, c.close].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
}
