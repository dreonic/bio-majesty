import { dateInZone, type Candle, type Quote, type StockAsset } from '@bio-majesty/shared';

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
  /** What the source knows about a symbol (throws when it has no data for it). */
  lookup(symbol: string): Promise<StockAsset>;
  /** Daily candles; `time` is normalized to 00:00 UTC of the trading date in the asset's time zone. */
  daily(asset: Pick<StockAsset, 'symbol' | 'timeZone'>, from: Date, to?: Date): Promise<StockSnapshot>;
  /** Intraday candles (delayed, regular session only); `time` is the bar's real UNIX timestamp. */
  intraday(symbol: string, from: Date): Promise<StockSnapshot>;
}

/** Normalize a bar timestamp to 00:00 UTC of its trading date in `timeZone` (stable daily x-axis). */
export function dailyTime(date: Date, timeZone: string): number {
  return Date.parse(`${dateInZone(timeZone, date)}T00:00:00Z`) / 1000;
}

export function isValidCandle(c: Partial<Candle>): c is Candle {
  return [c.open, c.high, c.low, c.close].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

/** Decimal places for an asset's prices: none when they are whole numbers (IDX stocks), else the source's hint. */
export function priceDecimals(closes: number[], priceHint: number | undefined): number {
  if (closes.length && closes.every((c) => Number.isInteger(c))) return 0;
  return Math.min(8, Math.max(0, priceHint ?? 2));
}
