import { z } from 'zod';
import { IsoDateTime } from './common';
import { dateTimeInZone, timeZoneLabel } from './time';

export const STOCK_RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'MAX'] as const;
export const StockRangeSchema = z.enum(STOCK_RANGES);
export type StockRange = z.infer<typeof StockRangeSchema>;
/** Ranges drawn from intraday bars (hidden for assets that only have daily bars). */
export const INTRADAY_RANGES: readonly StockRange[] = ['1D', '5D'];

/** Market-data sources. Each asset has one, chosen when it is added. */
export const STOCK_SOURCES = ['yahoo', 'eodhd'] as const;
export const StockSourceSchema = z.enum(STOCK_SOURCES);
export type StockSource = z.infer<typeof StockSourceSchema>;

/** How a source writes its symbols and when its prices arrive. */
export interface StockSourceInfo {
  label: string;
  /** Where people look a symbol up by hand. */
  site: string;
  /** Symbol syntax (trimmed, upper-cased). */
  pattern: RegExp;
  /** Example symbols in the source's own format, for the Add form. */
  examples: string;
  /** When intraday bars arrive: during the session ('live'), or only once the day is over ('after-close'). */
  intraday: 'live' | 'after-close';
  /** Days of intraday bars the source serves (what the intraday CSV download covers). */
  intradayDays: number;
  /** Minutes after the close before the day's bars are final: the end-of-day refresh waits this long. */
  settleMinutes: number;
}

export const STOCK_SOURCE_INFO: Record<StockSource, StockSourceInfo> = {
  yahoo: {
    label: 'Yahoo Finance',
    site: 'finance.yahoo.com',
    pattern: /^[A-Z0-9^][A-Z0-9.\-=^&]{0,19}$/,
    examples: 'PRDA.JK, AAPL, ^JKSE (index), USDIDR=X (currency), BTC-USD, GC=F (gold)',
    intraday: 'live',
    intradayDays: 60,
    settleMinutes: 60,
  },
  eodhd: {
    label: 'EODHD',
    site: 'eodhd.com',
    // TICKER.EXCHANGE: the exchange code is part of every symbol.
    pattern: /^[A-Z0-9^][A-Z0-9.\-_]{0,30}\.[A-Z]{2,6}$/,
    examples: 'PRDA.JK, AAPL.US, GSPC.INDX (index), EURUSD.FOREX (currency), BTC-USD.CC (crypto)',
    // Its intraday bars are finalized about 2-3 hours after the close.
    intraday: 'after-close',
    intradayDays: 120,
    settleMinutes: 180,
  },
};

/** Symbols are compared trimmed and upper-cased, in every source. */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Why `symbol` is not in the source's format, or null when it is. */
export function symbolProblem(source: StockSource, symbol: string): string | null {
  const info = STOCK_SOURCE_INFO[source];
  return info.pattern.test(normalizeSymbol(symbol)) ? null : `Not in ${info.label}'s symbol format. Examples: ${info.examples}`;
}

/**
 * An asset's ID: its source and its symbol in that source's own format, e.g. "yahoo:PRDA.JK" or
 * "eodhd:AAPL.US". Settings, stored market data and the API name assets by it, so the same
 * ticker from two sources is two assets with separate price histories.
 */
export function assetId(source: StockSource, symbol: string): string {
  return `${source}:${normalizeSymbol(symbol)}`;
}

/** Split an asset ID into its source and symbol. Returns null when malformed. */
export function parseAssetId(id: string): { source: StockSource; symbol: string } | null {
  const at = id.indexOf(':');
  if (at < 0) return null;
  const source = StockSourceSchema.safeParse(id.slice(0, at).trim().toLowerCase());
  if (!source.success) return null;
  const symbol = normalizeSymbol(id.slice(at + 1));
  return symbolProblem(source.data, symbol) ? null : { source: source.data, symbol };
}

/** An asset ID, normalized: " Yahoo:prda.jk" -> "yahoo:PRDA.JK". */
export const AssetIdSchema = z.string().transform((value, ctx) => {
  const parsed = parseAssetId(value);
  if (parsed) return assetId(parsed.source, parsed.symbol);
  ctx.addIssue({ code: 'custom', message: 'expected an asset ID such as yahoo:PRDA.JK' });
  return z.NEVER;
});

/**
 * Ticker as people say it: the exchange suffix dropped ("yahoo:PRDA.JK", "eodhd:PRDA.JK" -> "PRDA");
 * others unchanged ("yahoo:BTC-USD", "yahoo:^JKSE"). Anything that is not an asset ID is returned as it is.
 */
export function displaySymbol(id: string): string {
  const parsed = parseAssetId(id);
  if (!parsed) return id;
  // EODHD symbols always end in an exchange code; Yahoo's only for listings outside the US (PRDA.JK, D05.SI).
  return parsed.symbol.replace(parsed.source === 'eodhd' ? /\.[A-Z]+$/ : /\.[A-Z]{1,3}$/, '');
}

/** An asset's regular trading session on its exchange's clock. */
export const TradingSessionSchema = z.object({
  /** HH:mm in the asset's `timeZone`. */
  start: z.string(),
  end: z.string(),
  /** Mon–Fri, or every day (crypto). */
  days: z.enum(['weekdays', 'daily']),
});
export type TradingSession = z.infer<typeof TradingSessionSchema>;

/** What the market-data source says about an asset (shared by every account that tracks it). */
export const StockAssetSchema = z.object({
  /** "yahoo:PRDA.JK": see assetId. */
  id: z.string(),
  source: StockSourceSchema,
  /** The symbol in the source's own format ("PRDA.JK"). */
  symbol: z.string(),
  name: z.string().nullable(),
  exchange: z.string().nullable(),
  /** Instrument type, in Yahoo's words for every source: EQUITY, ETF, INDEX, CURRENCY, CRYPTOCURRENCY, FUTURE, MUTUALFUND … */
  type: z.string().nullable(),
  currency: z.string().nullable(),
  /** The exchange's IANA time zone: trading dates and the session are on this clock. */
  timeZone: z.string(),
  session: TradingSessionSchema,
  /** Interval of the intraday bars ("15m"), or null when the source only has daily bars (e.g. mutual funds). */
  intradayInterval: z.string().nullable(),
  /** Decimal places for prices: 0 for whole-rupiah IDX stocks, 2 for USD, 4 for most FX. */
  decimals: z.number().int().min(0).max(8),
  /** False when the asset has no trading volume (FX, most indices): no unusual-volume checks. */
  hasVolume: z.boolean(),
  /** First daily bar the source has. */
  firstTradeDate: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
});
export type StockAsset = z.infer<typeof StockAssetSchema>;

export const StockAssetsResponseSchema = z.object({
  items: z.array(StockAssetSchema),
  /** Sources new assets can come from: Yahoo always, the others once their API key is in the secret. */
  sources: z.array(StockSourceSchema),
});
export type StockAssetsResponse = z.infer<typeof StockAssetsResponseSchema>;

/** Track another asset: a source and a symbol in that source's format (normalized). */
export const AddAssetRequestSchema = z.object({ source: StockSourceSchema, symbol: z.string() }).transform(({ source, symbol }, ctx) => {
  const problem = symbolProblem(source, symbol);
  if (!problem) return { source, symbol: normalizeSymbol(symbol) };
  ctx.addIssue({ code: 'custom', path: ['symbol'], message: problem });
  return z.NEVER;
});
export const StockAssetRequestSchema = z.object({ asset: AssetIdSchema });

/** A symbol a source suggests for a name or ticker (the Add form's search). */
export const SymbolMatchSchema = z.object({
  id: z.string(),
  source: StockSourceSchema,
  symbol: z.string(),
  name: z.string().nullable(),
  exchange: z.string().nullable(),
  type: z.string().nullable(),
  currency: z.string().nullable(),
});
export type SymbolMatch = z.infer<typeof SymbolMatchSchema>;

export const StockSearchQuerySchema = z.object({ source: StockSourceSchema, q: z.string().trim().min(2).max(60) });
export const StockSearchResponseSchema = z.object({ items: z.array(SymbolMatchSchema) });
export type StockSearchResponse = z.infer<typeof StockSearchResponseSchema>;

/** OHLCV candle. `time` is UNIX seconds (UTC). Daily candles use 00:00 UTC of the trading date (the exchange's calendar). */
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
  /** The asset's ID. */
  asset: z.string(),
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
});
export type Quote = z.infer<typeof QuoteSchema>;

export const StockHistoryResponseSchema = z.object({
  asset: z.string(),
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

/**
 * CSV downloads: every stored daily bar, or the intraday bars the asset's source still has
 * (its `intradayDays`, fetched live: intraday bars are kept only briefly).
 */
export const StockExportIntervalSchema = z.enum(['1d', 'intraday']);
export type StockExportInterval = z.infer<typeof StockExportIntervalSchema>;

/** Button text for a bar interval: "15m" -> "15-min", "1h" -> "1-hour", "1d" -> "Daily". */
export function intervalLabel(interval: string): string {
  if (interval === '1d') return 'Daily';
  const m = /^(\d+)([mh])$/.exec(interval);
  if (!m) return interval;
  return `${m[1]}-${m[2] === 'm' ? 'min' : 'hour'}`;
}

export const StockExportResponseSchema = z.object({
  filename: z.string(),
  rows: z.number(),
  csv: z.string(),
});
export type StockExportResponse = z.infer<typeof StockExportResponseSchema>;

/** A trading day whose volume is far above its recent average. */
export const VolumeAnomalySchema = z.object({
  /** YYYY-MM-DD (the asset's trading date). */
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

/**
 * Bars as CSV (CRLF rows), oldest first, numbers unformatted. `interval` is "1d" or the intraday bar
 * interval ("15m"). Daily bars carry their trading date, intraday bars their start time in
 * `timeZone` (the exec's clock). No cell needs quoting.
 */
export function stockCsv(symbol: string, interval: string, candles: Candle[], timeZone: string): StockExportResponse {
  const daily = interval === '1d';
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const stamp = (time: number) => (daily ? candleDate(time) : dateTimeInZone(timeZone, new Date(time * 1000)));
  const header = [daily ? 'Date' : `Time (${timeZoneLabel(timeZone)})`, 'Open', 'High', 'Low', 'Close', 'Volume'];
  const lines = [header, ...sorted.map((c) => [stamp(c.time), c.open, c.high, c.low, c.close, c.volume])].map((r) => r.join(','));
  const day = (time: number) => stamp(time).slice(0, 10);
  const span = sorted.length ? `_${day(sorted[0]!.time)}_${day(sorted.at(-1)!.time)}` : '';
  const slug = daily ? 'daily' : intervalLabel(interval).replace('-', '');
  return { filename: `${symbol}_${slug}${span}.csv`, rows: sorted.length, csv: `${lines.join('\r\n')}\r\n` };
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
