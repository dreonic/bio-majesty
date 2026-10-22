import {
  assetId,
  dateInZone,
  isValidTimeZone,
  normalizeSymbol,
  symbolProblem,
  type Candle,
  type Quote,
  type StockAsset,
  type SymbolMatch,
  type TradingSession,
} from '@bio-majesty/shared';
import { errorMessage } from '../lib/logger';
import { getSecret } from '../lib/secrets';
import { addDays } from '../lib/time';
import { fetchWithRetry, HttpStatusError } from '../sources/http-fetch';
import { isValidCandle, type AssetRef, type StockProvider, type StockSnapshot } from './provider';

const API = 'https://eodhd.com/api';
/** Search results the Add form shows. */
const SEARCH_RESULTS = 8;

/**
 * EODHD's virtual exchanges: no exchange details (time zone, hours), so their assets are
 * followed around the clock on UTC.
 */
const VIRTUAL_EXCHANGES: Record<string, { type: string; days: TradingSession['days'] }> = {
  CC: { type: 'CRYPTOCURRENCY', days: 'daily' },
  FOREX: { type: 'CURRENCY', days: 'weekdays' },
  INDX: { type: 'INDEX', days: 'weekdays' },
};

/** An EODHD request failed. The message never contains the API key. */
export class EodhdError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

interface EodRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
interface IntradayRow {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
/** Missing values come as "NA". */
interface RealTimeRow {
  timestamp?: unknown;
  close?: unknown;
  high?: unknown;
  low?: unknown;
  volume?: unknown;
  previousClose?: unknown;
  change?: unknown;
  change_p?: unknown;
}
interface SearchRow {
  Code: string;
  Exchange: string;
  Name?: string;
  Type?: string;
  Country?: string;
  Currency?: string;
}
interface ExchangeDetails {
  Name?: string;
  Timezone?: string;
  TradingHours?: { Open?: string; Close?: string; WorkingDays?: string };
}

/**
 * EODHD (paid, https://eodhd.com). Requires EODHD_API_KEY in the secret. Symbols are
 * TICKER.EXCHANGE (PRDA.JK, AAPL.US). Intraday bars come in 5-minute resolution, are rolled up
 * to 15 minutes, and are only finalized 2-3 hours after the close (STOCK_SOURCE_INFO.eodhd).
 */
export class EodhdStockProvider implements StockProvider {
  readonly source = 'eodhd';

  async lookup(symbol: string): Promise<StockAsset> {
    const ref = { id: assetId(this.source, symbol), symbol };
    const { code, exchange } = splitSymbol(symbol);
    const now = new Date();
    const [quote, recent, match, details] = await Promise.all([
      this.quote(ref).catch(notFound(null)),
      this.eod(symbol, dateInZone('UTC', addDays(now, -40)), dateInZone('UTC', now)).catch(notFound<Candle[]>([])),
      // Name, type and currency: the search API is the cheapest place that has them.
      this.searchRows(code, { exchange, limit: '50' })
        .then((rows) => rows.find((r) => r.Code.toUpperCase() === code && r.Exchange.toUpperCase() === exchange) ?? null)
        .catch(() => null),
      this.exchangeDetails(exchange),
    ]);
    if (!quote && !recent.length) throw new Error(`EODHD has no data for ${symbol}`);
    const type = instrumentType(match?.Type, exchange);
    return {
      id: ref.id,
      source: this.source,
      symbol,
      name: match?.Name ?? null,
      exchange: details?.Name ?? exchange,
      type,
      currency: match?.Currency ?? null,
      timeZone: details?.Timezone && isValidTimeZone(details.Timezone) ? details.Timezone : 'UTC',
      session: sessionFrom(details?.TradingHours, VIRTUAL_EXCHANGES[exchange]?.days ?? 'weekdays'),
      intradayInterval: type === 'MUTUALFUND' ? null : '15m',
      decimals: decimalsOf(recent.length ? recent.map((c) => c.close) : quote ? [quote.price] : []),
      hasVolume: recent.some((c) => c.volume > 0) || (quote?.volume ?? 0) > 0,
      firstTradeDate: null,
      updatedAt: now.toISOString(),
    };
  }

  async search(query: string): Promise<SymbolMatch[]> {
    return (await this.searchRows(query)).flatMap((r) => {
      const symbol = normalizeSymbol(`${r.Code}.${r.Exchange}`);
      if (symbolProblem(this.source, symbol)) return [];
      return [
        {
          id: assetId(this.source, symbol),
          source: this.source,
          symbol,
          name: r.Name ?? null,
          exchange: [r.Exchange, r.Country].filter(Boolean).join(' · ') || null,
          type: instrumentType(r.Type, r.Exchange.toUpperCase()),
          currency: r.Currency ?? null,
        },
      ];
    });
  }

  async daily(asset: AssetRef & Pick<StockAsset, 'timeZone'>, from: Date, to?: Date): Promise<StockSnapshot> {
    const [candles, quote] = await Promise.all([
      this.eod(asset.symbol, dateInZone(asset.timeZone, from), dateInZone(asset.timeZone, to ?? new Date())),
      this.quote(asset),
    ]);
    return { candles, quote };
  }

  async intraday(asset: AssetRef, from: Date): Promise<StockSnapshot> {
    const [rows, quote] = await Promise.all([
      this.get<IntradayRow[]>(`intraday/${encodeURIComponent(asset.symbol)}`, { interval: '5m', from: String(Math.floor(from.getTime() / 1000)) }),
      this.quote(asset),
    ]);
    const bars = rows
      .map((r) => ({ time: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 }))
      .filter(isValidCandle);
    return { candles: rollup(bars, 15 * 60), quote };
  }

  async quote(asset: AssetRef): Promise<Quote | null> {
    const q = await this.get<RealTimeRow>(`real-time/${encodeURIComponent(asset.symbol)}`);
    const price = num(q.close);
    if (price === null) return null;
    const timestamp = num(q.timestamp);
    return {
      asset: asset.id,
      price,
      previousClose: num(q.previousClose),
      change: num(q.change),
      changePercent: num(q.change_p),
      dayHigh: num(q.high),
      dayLow: num(q.low),
      volume: num(q.volume),
      currency: null,
      marketTime: timestamp !== null ? new Date(timestamp * 1000).toISOString() : null,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Daily bars between two trading dates (`date` is already the exchange's trading date). */
  private async eod(symbol: string, from: string, to: string): Promise<Candle[]> {
    const rows = await this.get<EodRow[]>(`eod/${encodeURIComponent(symbol)}`, { from, to });
    return rows
      .map((r) => ({ time: Date.parse(`${r.date}T00:00:00Z`) / 1000, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 }))
      .filter(isValidCandle);
  }

  private searchRows(query: string, params: Record<string, string> = {}): Promise<SearchRow[]> {
    return this.get<SearchRow[]>(`search/${encodeURIComponent(query)}`, { limit: String(SEARCH_RESULTS), ...params });
  }

  /**
   * An exchange's time zone and trading hours: the v2 endpoint, else the legacy one (which covers
   * every exchange). Null for virtual exchanges or when EODHD has no details.
   */
  private async exchangeDetails(code: string): Promise<ExchangeDetails | null> {
    if (VIRTUAL_EXCHANGES[code]) return null;
    for (const path of [`v2/exchange-details/${code}`, `exchange-details/${code}`]) {
      try {
        // v2 wraps the details in `data`; v1 returns them as they are.
        const body = await this.get<ExchangeDetails & { data?: ExchangeDetails }>(path);
        const details = body.data ?? body;
        if (details.Timezone) return details;
      } catch {
        // Try the other version.
      }
    }
    return null;
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const token = await getSecret('EODHD_API_KEY');
    if (!token) throw new EodhdError('EODHD_API_KEY is not set in the secret', null);
    const query = new URLSearchParams({ ...params, api_token: token, fmt: 'json' });
    try {
      const res = await fetchWithRetry(`${API}/${path}?${query}`);
      return (await res.json()) as T;
    } catch (err) {
      // Error messages carry the request URL: keep the API key (as typed and as encoded in the URL)
      // out of logs, stored errors and alerts.
      const secrets = [token, new URLSearchParams({ k: token }).toString().slice(2)];
      const message = secrets.reduce((text, secret) => text.replaceAll(secret, '<EODHD_API_KEY>'), errorMessage(err));
      throw new EodhdError(message, err instanceof HttpStatusError ? err.status : null);
    }
  }
}

/** PRDA.JK -> { code: 'PRDA', exchange: 'JK' } (the exchange code follows the last dot). */
function splitSymbol(symbol: string): { code: string; exchange: string } {
  const dot = symbol.lastIndexOf('.');
  return { code: symbol.slice(0, dot), exchange: symbol.slice(dot + 1) };
}

/** A 404 means EODHD has nothing for the symbol; any other failure (bad key, rate limit) is an error. */
function notFound<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (err instanceof EodhdError && err.status === 404) return fallback;
    throw err;
  };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** EODHD's instrument types ("Common Stock", "ETF", "FUND", "INDEX" …) in Yahoo's words, which the dashboard uses everywhere. */
export function instrumentType(type: string | undefined, exchange: string): string | null {
  const t = (type ?? '').toLowerCase();
  if (/stock|share|equity/.test(t)) return 'EQUITY';
  if (/\b(etf|etc|etn)\b/.test(t)) return 'ETF';
  if (/fund/.test(t)) return 'MUTUALFUND';
  if (/index/.test(t)) return 'INDEX';
  if (/currency|forex/.test(t)) return 'CURRENCY';
  if (/crypto/.test(t)) return 'CRYPTOCURRENCY';
  if (/future|commodit/.test(t)) return 'FUTURE';
  return VIRTUAL_EXCHANGES[exchange]?.type ?? (type ? type.toUpperCase() : null);
}

/** The regular session from EODHD's trading hours ("09:00:00"); round the clock when it has none. */
export function sessionFrom(hours: { Open?: string; Close?: string; WorkingDays?: string } | undefined, days: TradingSession['days']): TradingSession {
  const hhmm = (v: string | undefined) => (v && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null);
  const start = hhmm(hours?.Open);
  const end = hhmm(hours?.Close);
  if (!start || !end) return { start: '00:00', end: '23:59', days };
  return { start, end, days: /sat|sun/i.test(hours?.WorkingDays ?? '') ? 'daily' : 'weekdays' };
}

/** Decimal places that show prices as the source quotes them: none for whole numbers (IDX stocks), else 2 to 4. */
export function decimalsOf(prices: number[]): number {
  if (!prices.length) return 2;
  if (prices.every((p) => Number.isInteger(p))) return 0;
  const places = Math.max(...prices.map((p) => (String(p).split('.')[1] ?? '').length));
  return Math.min(4, Math.max(2, places));
}

/** Aggregate bars into fixed buckets of `seconds`. */
export function rollup(bars: Candle[], seconds: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const bar of [...bars].sort((a, b) => a.time - b.time)) {
    const key = Math.floor(bar.time / seconds) * seconds;
    const cur = buckets.get(key);
    if (!cur) buckets.set(key, { ...bar, time: key });
    else {
      cur.high = Math.max(cur.high, bar.high);
      cur.low = Math.min(cur.low, bar.low);
      cur.close = bar.close;
      cur.volume += bar.volume;
    }
  }
  return [...buckets.values()];
}
