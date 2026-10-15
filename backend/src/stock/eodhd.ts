import type { Candle, Quote } from '@bio-majesty/shared';
import { getSecret } from '../lib/secrets';
import { jakartaDate } from '../lib/time';
import { fetchWithRetry } from '../sources/http-fetch';
import { dailyTime, isValidCandle, type StockProvider, type StockSnapshot } from './provider';

/**
 * EODHD (paid alternative, https://eodhd.com). Requires EODHD_API_KEY in the
 * secret. Intraday bars come in 5-minute resolution and are rolled up to 15m.
 */
export class EodhdStockProvider implements StockProvider {
  readonly name = 'eodhd';

  private async token(): Promise<string> {
    const token = await getSecret('EODHD_API_KEY');
    if (!token) throw new Error('EODHD_API_KEY is not set in the secret');
    return token;
  }

  async daily(symbol: string, from: Date, to?: Date): Promise<StockSnapshot> {
    const token = await this.token();
    const params = new URLSearchParams({ api_token: token, fmt: 'json', from: jakartaDate(from), to: jakartaDate(to ?? new Date()) });
    const res = await fetchWithRetry(`https://eodhd.com/api/eod/${encodeURIComponent(symbol)}?${params}`);
    const rows = (await res.json()) as { date: string; open: number; high: number; low: number; close: number; volume: number }[];
    const candles = rows
      .map((r) => ({
        time: dailyTime(new Date(`${r.date}T09:00:00+07:00`)),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume ?? 0,
      }))
      .filter(isValidCandle);
    return { candles, quote: await this.quote(symbol, token) };
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
      currency: 'IDR',
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
