import type { Candle, Quote } from '@bio-majesty/shared';
import YahooFinance from 'yahoo-finance2';
import { dailyTime, isValidCandle, type StockProvider, type StockSnapshot } from './provider';

/**
 * Yahoo Finance via the unofficial `yahoo-finance2` library (free, no SLA,
 * may rate-limit cloud IPs). Uses only the chart endpoint, whose metadata
 * also carries the current (delayed) quote, to keep request counts low.
 */
export class YahooStockProvider implements StockProvider {
  readonly name = 'yahoo';
  private readonly yf = new YahooFinance({ suppressNotices: ['yahooSurvey'], versionCheck: false });

  async daily(symbol: string, from: Date, to?: Date): Promise<StockSnapshot> {
    return this.fetch(symbol, { period1: from, period2: to, interval: '1d' }, true);
  }

  async intraday(symbol: string, from: Date): Promise<StockSnapshot> {
    return this.fetch(symbol, { period1: from, interval: '15m' }, false);
  }

  private async fetch(
    symbol: string,
    options: { period1: Date; period2?: Date; interval: '1d' | '15m' },
    daily: boolean,
  ): Promise<StockSnapshot> {
    const result = await this.yf.chart(symbol, { ...options, return: 'array' });
    const candles: Candle[] = [];
    for (const q of result.quotes) {
      const candle = {
        time: daily ? dailyTime(q.date) : Math.floor(q.date.getTime() / 1000),
        open: q.open ?? NaN,
        high: q.high ?? NaN,
        low: q.low ?? NaN,
        close: q.close ?? NaN,
        volume: q.volume ?? 0,
      };
      if (isValidCandle(candle)) candles.push(candle);
    }
    const meta = result.meta;
    const previous = meta.previousClose ?? meta.chartPreviousClose ?? null;
    const price = meta.regularMarketPrice;
    const quote: Quote | null =
      typeof price === 'number'
        ? {
            symbol,
            price,
            previousClose: previous,
            change: previous !== null ? price - previous : null,
            changePercent: previous ? ((price - previous) / previous) * 100 : null,
            dayHigh: meta.regularMarketDayHigh ?? null,
            dayLow: meta.regularMarketDayLow ?? null,
            volume: meta.regularMarketVolume ?? null,
            currency: meta.currency ?? null,
            marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime).toISOString() : null,
            updatedAt: new Date().toISOString(),
            provider: this.name,
          }
        : null;
    return { candles, quote };
  }
}
