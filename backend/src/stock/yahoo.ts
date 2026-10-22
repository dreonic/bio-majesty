import { assetId, isValidTimeZone, type Candle, type Quote, type StockAsset, type SymbolMatch } from '@bio-majesty/shared';
import YahooFinance from 'yahoo-finance2';
import type { ChartMeta, ChartResultArray } from 'yahoo-finance2/modules/chart';
import { addDays } from '../lib/time';
import { dailyTime, isValidCandle, priceDecimals, type AssetRef, type StockProvider, type StockSnapshot } from './provider';
import { deriveSession } from './session';

/** Search results the Add form shows. */
const SEARCH_RESULTS = 8;

/**
 * Yahoo Finance via the unofficial `yahoo-finance2` library (free, no SLA,
 * may rate-limit cloud IPs). Prices come from the chart endpoint only, whose metadata
 * also carries the current (delayed) quote, to keep request counts low.
 * Intraday data: 15-minute bars for the last 60 days (stocks, ETFs, indices,
 * FX, crypto, futures); mutual funds only have daily bars.
 */
export class YahooStockProvider implements StockProvider {
  readonly source = 'yahoo';
  private readonly yf = new YahooFinance({ suppressNotices: ['yahooSurvey'], versionCheck: false });

  async lookup(symbol: string): Promise<StockAsset> {
    const now = new Date();
    // A 15-minute request reports the interval Yahoo really has (mutual funds fall back to "1d").
    const recent = await this.yf.chart(symbol, { period1: addDays(now, -5), interval: '15m', includePrePost: false, return: 'array' });
    const daily = await this.yf.chart(symbol, { period1: addDays(now, -40), interval: '1d', return: 'array' });
    const meta = recent.meta;
    if (typeof meta.regularMarketPrice !== 'number' && !daily.quotes.length) throw new Error(`Yahoo Finance has no data for ${symbol}`);
    const timeZone = meta.exchangeTimezoneName && isValidTimeZone(meta.exchangeTimezoneName) ? meta.exchangeTimezoneName : 'UTC';
    const granularity = meta.dataGranularity;
    const type = meta.instrumentType ?? null;
    const closes = daily.quotes.map((q) => q.close).filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
    const regular = meta.currentTradingPeriod?.regular;
    return {
      id: assetId(this.source, symbol),
      source: this.source,
      symbol,
      name: meta.longName ?? meta.shortName ?? null,
      exchange: meta.fullExchangeName ?? meta.exchangeName ?? null,
      type,
      currency: meta.currency ?? null,
      timeZone,
      session: regular ? deriveSession(regular, timeZone, type) : { start: '00:00', end: '23:59', days: 'weekdays' },
      intradayInterval: granularity && /^\d+[mh]$/.test(granularity) ? granularity : null,
      decimals: priceDecimals(closes, meta.priceHint),
      hasVolume: [...daily.quotes, ...recent.quotes].some((q) => (q.volume ?? 0) > 0),
      firstTradeDate: meta.firstTradeDate ? new Date(meta.firstTradeDate).toISOString() : null,
      updatedAt: now.toISOString(),
    };
  }

  async search(query: string): Promise<SymbolMatch[]> {
    const result = await this.yf.search(query, { quotesCount: SEARCH_RESULTS, newsCount: 0, enableFuzzyQuery: true });
    // Non-Yahoo entries are Crunchbase companies without prices; options would flood the list.
    return result.quotes.flatMap((q) =>
      q.isYahooFinance && q.quoteType !== 'OPTION'
        ? [
            {
              id: assetId(this.source, q.symbol),
              source: this.source,
              symbol: q.symbol,
              name: q.longname ?? q.shortname ?? null,
              exchange: q.exchDisp ?? q.exchange ?? null,
              type: q.quoteType,
              currency: null,
            },
          ]
        : [],
    );
  }

  async daily(asset: AssetRef & Pick<StockAsset, 'timeZone'>, from: Date, to?: Date): Promise<StockSnapshot> {
    // yahoo-finance2 rejects `period2: undefined`, so the key is only set with an end date.
    const result = await this.yf.chart(asset.symbol, { period1: from, ...(to && { period2: to }), interval: '1d', return: 'array' });
    return snapshot(asset, result, (date) => dailyTime(date, asset.timeZone));
  }

  async intraday(asset: AssetRef, from: Date): Promise<StockSnapshot> {
    // Regular session only: US listings would otherwise include pre-market and after-hours bars.
    const result = await this.yf.chart(asset.symbol, { period1: from, interval: '15m', includePrePost: false, return: 'array' });
    return snapshot(asset, result, (date) => Math.floor(date.getTime() / 1000));
  }

  async quote(asset: AssetRef): Promise<Quote | null> {
    const result = await this.yf.chart(asset.symbol, { period1: addDays(new Date(), -5), interval: '1d', return: 'array' });
    return quoteFrom(asset, result.meta);
  }
}

function snapshot(asset: AssetRef, result: ChartResultArray, time: (date: Date) => number): StockSnapshot {
  const candles: Candle[] = [];
  for (const q of result.quotes) {
    const candle = {
      time: time(q.date),
      open: q.open ?? NaN,
      high: q.high ?? NaN,
      low: q.low ?? NaN,
      close: q.close ?? NaN,
      volume: q.volume ?? 0,
    };
    if (isValidCandle(candle)) candles.push(candle);
  }
  return { candles, quote: quoteFrom(asset, result.meta) };
}

function quoteFrom(asset: AssetRef, meta: ChartMeta): Quote | null {
  const previous = meta.previousClose ?? meta.chartPreviousClose ?? null;
  const price = meta.regularMarketPrice;
  if (typeof price !== 'number') return null;
  return {
    asset: asset.id,
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
  };
}
