import { dateInZone, MARKET_TIME_ZONE, type Candle, type Quote, type StockAsset } from '@bio-majesty/shared';
import { getSecret } from '../lib/secrets';
import { fetchWithRetry } from '../sources/http-fetch';
import { isValidCandle, type StockProvider, type StockSnapshot } from './provider';

/** Exchange suffix (EODHD symbol format) -> time zone; anything else is treated as UTC. */
const SUFFIX_ZONES: Record<string, string> = { JK: MARKET_TIME_ZONE, SG: 'Asia/Singapore', US: 'America/New_York' };

/**
 * EODHD (paid alternative, https://eodhd.com). Requires EODHD_API_KEY in the
 * secret. Intraday bars come in 5-minute resolution and are rolled up to 15m.
 * Its symbols use EODHD's own format (e.g. PRDA.JK, AAPL.US); `lookup` is basic.
 */
export class EodhdStockProvider implements StockProvider {
  readonly name = 'eodhd';

  private async token(): Promise<string> {
    const token = await getSecret('EODHD_API_KEY');
    if (!token) throw new Error('EODHD_API_KEY is not set in the secret');
    return token;
  }

  async lookup(symbol: string): Promise<StockAsset> {
    const quote = await this.quote(symbol, await this.token());
    if (!quote) throw new Error(`EODHD has no data for ${symbol}`);
    const suffix = symbol.split('.').pop() ?? '';
    const idx = suffix === 'JK';
    return {
      symbol,
      name: null,
      exchange: suffix || null,
      type: null,
      currency: quote.currency,
      timeZone: SUFFIX_ZONES[suffix] ?? 'UTC',
      session: idx ? { start: '09:00', end: '16:15', days: 'weekdays' } : { start: '09:30', end: '16:00', days: 'weekdays' },
      intradayInterval: '15m',
      decimals: idx ? 0 : 2,
      hasVolume: true,
      firstTradeDate: null,
      updatedAt: new Date().toISOString(),
    };
  }

  async daily(asset: Pick<StockAsset, 'symbol' | 'timeZone'>, from: Date, to?: Date): Promise<StockSnapshot> {
    const token = await this.token();
    const params = new URLSearchParams({
      api_token: token,
      fmt: 'json',
      from: dateInZone(asset.timeZone, from),
      to: dateInZone(asset.timeZone, to ?? new Date()),
    });
    const res = await fetchWithRetry(`https://eodhd.com/api/eod/${encodeURIComponent(asset.symbol)}?${params}`);
    const rows = (await res.json()) as { date: string; open: number; high: number; low: number; close: number; volume: number }[];
    const candles = rows
      .map((r) => ({
        // `date` is already the exchange's trading date.
        time: Date.parse(`${r.date}T00:00:00Z`) / 1000,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume ?? 0,
      }))
      .filter(isValidCandle);
    return { candles, quote: await this.quote(asset.symbol, token) };
  }

  async intraday(symbol: string, from: Date): Promise<StockSnapshot> {
    const token = await this.token();
    const params = new URLSearchParams({
      api_token: token,
      fmt: 'json',
      interval: '5m',
      from: String(Math.floor(from.getTime() / 1000)),
    });
    const res = await fetchWithRetry(`https://eodhd.com/api/intraday/${encodeURIComponent(symbol)}?${params}`);
    const rows = (await res.json()) as { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[];
    const bars = rows
      .map((r) => ({ time: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 }))
      .filter(isValidCandle);
    return { candles: rollup(bars, 15 * 60), quote: await this.quote(symbol, token) };
  }

  private async quote(symbol: string, token: string): Promise<Quote | null> {
    const res = await fetchWithRetry(
      `https://eodhd.com/api/real-time/${encodeURIComponent(symbol)}?api_token=${encodeURIComponent(token)}&fmt=json`,
    );
    const q = (await res.json()) as {
      timestamp?: number;
      close?: number;
      high?: number;
      low?: number;
      volume?: number;
      previousClose?: number;
      change?: number;
      change_p?: number;
    };
    if (typeof q.close !== 'number') return null;
    return {
      symbol,
      price: q.close,
      previousClose: q.previousClose ?? null,
      change: q.change ?? null,
      changePercent: q.change_p ?? null,
      dayHigh: q.high ?? null,
      dayLow: q.low ?? null,
      volume: q.volume ?? null,
      currency: symbol.endsWith('.JK') ? 'IDR' : null,
      marketTime: q.timestamp ? new Date(q.timestamp * 1000).toISOString() : null,
      updatedAt: new Date().toISOString(),
      provider: this.name,
    };
  }
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
