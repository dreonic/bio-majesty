import { dateInZone, type Candle, type Quote, type StockAsset, type StockSource, type SymbolMatch } from '@bio-majesty/shared';

export interface StockSnapshot {
  candles: Candle[];
  quote: Quote | null;
}

/** What a source needs to fetch an asset's prices: its ID (quotes carry it) and its symbol in the source's format. */
export type AssetRef = Pick<StockAsset, 'id' | 'symbol'>;

/**
 * A market-data source. Every asset names its own (StockAsset.source); stockProvider(source)
 * returns the implementation. Symbols are in the source's own format (STOCK_SOURCE_INFO).
 */
export interface StockProvider {
  readonly source: StockSource;
  /** What the source knows about a symbol (throws when it has no data for it). */
  lookup(symbol: string): Promise<StockAsset>;
  /** Symbols matching a name or ticker, best first: the Add form's search. */
  search(query: string): Promise<SymbolMatch[]>;
  /** Daily candles; `time` is normalized to 00:00 UTC of the trading date in the asset's time zone. */
  daily(asset: AssetRef & Pick<StockAsset, 'timeZone'>, from: Date, to?: Date): Promise<StockSnapshot>;
  /** Intraday candles (delayed, regular session only); `time` is the bar's real UNIX timestamp. */
  intraday(asset: AssetRef, from: Date): Promise<StockSnapshot>;
  /** The latest (delayed) quote. Assets whose source has no live intraday bars are followed through it during the session. */
  quote(asset: AssetRef): Promise<Quote | null>;
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
