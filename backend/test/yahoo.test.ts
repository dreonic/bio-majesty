import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Record<string, unknown>[] = [];
/** What the fake chart endpoint answers, by interval. */
const answers: Record<string, { quotes: Record<string, unknown>[]; meta: Record<string, unknown> }> = {};
const searched: { query: string; options: Record<string, unknown> }[] = [];

// yahoo-finance2 validates options and rejects `period2: undefined`; record what the provider passes.
vi.mock('yahoo-finance2', () => ({
  default: class {
    async chart(_symbol: string, options: Record<string, unknown>) {
      calls.push(options);
      return answers[String(options.interval)] ?? { quotes: [], meta: {} };
    }
    async search(query: string, options: Record<string, unknown>) {
      searched.push({ query, options });
      return {
        quotes: [
          { isYahooFinance: true, symbol: 'PRDA.JK', exchange: 'JKT', exchDisp: 'Jakarta', quoteType: 'EQUITY', longname: 'PT Prodia Widyahusada Tbk', shortname: 'Prodia Widyahusada' },
          { isYahooFinance: true, symbol: 'PRDA250117C00001000', exchange: 'OPR', quoteType: 'OPTION', shortname: 'An option' },
          { isYahooFinance: false, name: 'Prodia (AI images)', permalink: 'prodia' },
        ],
      };
    }
  },
}));

const { YahooStockProvider } = await import('../src/stock/yahoo');

const prda = { id: 'yahoo:PRDA.JK', symbol: 'PRDA.JK', timeZone: 'Asia/Jakarta' };

describe('Yahoo provider', () => {
  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(answers)) delete answers[key];
  });

  it('leaves period2 out when no end date is given (the full-history load)', async () => {
    await new YahooStockProvider().daily(prda, new Date('2016-12-01T00:00:00Z'));
    expect(calls[0]).not.toHaveProperty('period2');
    expect(calls[0]).toMatchObject({ interval: '1d', return: 'array' });
  });

  it('passes period2 when an end date is given', async () => {
    const to = new Date('2026-10-16T00:00:00Z');
    await new YahooStockProvider().daily(prda, new Date('2026-10-01T00:00:00Z'), to);
    expect(calls[0]).toMatchObject({ period2: to });
  });

  it('asks for regular-session 15-minute bars without an end date', async () => {
    await new YahooStockProvider().intraday({ id: 'yahoo:AAPL', symbol: 'AAPL' }, new Date('2026-10-14T00:00:00Z'));
    expect(calls[0]).not.toHaveProperty('period2');
    expect(calls[0]).toMatchObject({ interval: '15m', includePrePost: false });
  });

  it("dates daily bars on the asset's exchange calendar", async () => {
    // Yahoo stamps US daily bars at the 09:30 open (13:30 UTC): still the same New York date.
    answers['1d'] = { quotes: [{ date: new Date('2026-10-20T13:30:00Z'), open: 1, high: 2, low: 1, close: 2, volume: 5 }], meta: {} };
    const { candles } = await new YahooStockProvider().daily({ id: 'yahoo:AAPL', symbol: 'AAPL', timeZone: 'America/New_York' }, new Date('2026-10-01T00:00:00Z'));
    expect(new Date(candles[0]!.time * 1000).toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('looks up an asset: name, exchange clock, session, interval, decimals and volume', async () => {
    answers['15m'] = {
      quotes: [],
      meta: {
        regularMarketPrice: 2900,
        dataGranularity: '15m',
        exchangeTimezoneName: 'Asia/Jakarta',
        instrumentType: 'EQUITY',
        longName: 'PT Prodia Widyahusada Tbk',
        fullExchangeName: 'Jakarta',
        currency: 'IDR',
        priceHint: 2,
        firstTradeDate: new Date('2016-12-09T02:00:00Z'),
        currentTradingPeriod: { regular: { start: new Date('2026-10-21T02:00:00Z'), end: new Date('2026-10-21T09:15:00Z') } },
      },
    };
    answers['1d'] = { quotes: [{ date: new Date(), open: 2880, high: 2910, low: 2870, close: 2900, volume: 120_000 }], meta: {} };
    expect(await new YahooStockProvider().lookup('PRDA.JK')).toMatchObject({
      id: 'yahoo:PRDA.JK',
      source: 'yahoo',
      symbol: 'PRDA.JK',
      name: 'PT Prodia Widyahusada Tbk',
      exchange: 'Jakarta',
      type: 'EQUITY',
      timeZone: 'Asia/Jakarta',
      session: { start: '09:00', end: '16:15', days: 'weekdays' },
      intradayInterval: '15m',
      decimals: 0,
      hasVolume: true,
      firstTradeDate: '2016-12-09T02:00:00.000Z',
    });
  });

  it('marks assets that only have daily bars (Yahoo answers a 15-minute request with "1d")', async () => {
    answers['15m'] = { quotes: [], meta: { regularMarketPrice: 610.2, dataGranularity: '1d', exchangeTimezoneName: 'America/New_York', instrumentType: 'MUTUALFUND', priceHint: 2 } };
    answers['1d'] = { quotes: [{ date: new Date(), open: 610, high: 611, low: 609, close: 610.2, volume: 0 }], meta: {} };
    expect(await new YahooStockProvider().lookup('VFIAX')).toMatchObject({ intradayInterval: null, hasVolume: false, decimals: 2 });
  });

  it('searches for symbols with prices: no Crunchbase companies, no options', async () => {
    expect(await new YahooStockProvider().search('prodia')).toEqual([
      { id: 'yahoo:PRDA.JK', source: 'yahoo', symbol: 'PRDA.JK', name: 'PT Prodia Widyahusada Tbk', exchange: 'Jakarta', type: 'EQUITY', currency: null },
    ]);
    expect(searched[0]).toMatchObject({ query: 'prodia', options: { newsCount: 0 } });
  });

  it('quotes an asset under its ID', async () => {
    answers['1d'] = { quotes: [], meta: { regularMarketPrice: 2900, previousClose: 2850, currency: 'IDR', regularMarketTime: new Date('2026-10-21T09:00:00Z') } };
    expect(await new YahooStockProvider().quote(prda)).toMatchObject({ asset: 'yahoo:PRDA.JK', price: 2900, change: 50, currency: 'IDR', marketTime: '2026-10-21T09:00:00.000Z' });
  });
});
