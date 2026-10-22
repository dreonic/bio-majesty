import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'demo-token.123';
vi.mock('../src/lib/secrets', () => ({ getSecret: async (name: string) => (name === 'EODHD_API_KEY' ? TOKEN : undefined) }));

const { EodhdStockProvider, decimalsOf, instrumentType } = await import('../src/stock/eodhd');

/** Fake EODHD: answers by URL path (status 200 unless given); records every request. */
let routes: Record<string, unknown | { status: number; body: unknown }> = {};
const requests: URL[] = [];
const reply = (status: number, body: unknown) => ({ status, body });

beforeEach(() => {
  routes = {};
  requests.length = 0;
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    const route = routes[url.pathname];
    const { status, body } =
      route && typeof route === 'object' && 'status' in route ? (route as { status: number; body: unknown }) : { status: route === undefined ? 404 : 200, body: route ?? { error: 'Not found' } };
    return new Response(JSON.stringify(body), { status });
  });
});
afterEach(() => vi.unstubAllGlobals());

const prdaQuote = { code: 'PRDA.JK', timestamp: 1_792_565_400, open: 2880, high: 2910, low: 2870, close: 2900, volume: 120_000, previousClose: 2850, change: 50, change_p: 1.7544 };
const prdaDays = [
  { date: '2026-10-20', open: 2850, high: 2870, low: 2840, close: 2850, adjusted_close: 2850, volume: 90_000 },
  { date: '2026-10-21', open: 2880, high: 2910, low: 2870, close: 2900, adjusted_close: 2900, volume: 120_000 },
];

describe('EODHD provider', () => {
  it("looks up an asset from its quote, recent days, the search API and the exchange's details", async () => {
    routes['/api/real-time/PRDA.JK'] = prdaQuote;
    routes['/api/eod/PRDA.JK'] = prdaDays;
    routes['/api/search/PRDA'] = [
      { Code: 'PRDA', Exchange: 'JK', Name: 'Prodia Widyahusada Tbk PT', Type: 'Common Stock', Country: 'Indonesia', Currency: 'IDR' },
      { Code: 'PRDAX', Exchange: 'US', Name: 'Something else', Type: 'FUND', Country: 'USA', Currency: 'USD' },
    ];
    routes['/api/v2/exchange-details/JK'] = {
      data: { Name: 'Jakarta Exchange', Code: 'JK', Timezone: 'Asia/Jakarta', TradingHours: { Open: '09:00:00', Close: '16:00:00', WorkingDays: 'Mon, Tue, Wed, Thu, Fri' } },
    };
    expect(await new EodhdStockProvider().lookup('PRDA.JK')).toMatchObject({
      id: 'eodhd:PRDA.JK',
      source: 'eodhd',
      symbol: 'PRDA.JK',
      name: 'Prodia Widyahusada Tbk PT',
      exchange: 'Jakarta Exchange',
      type: 'EQUITY',
      currency: 'IDR',
      timeZone: 'Asia/Jakarta',
      session: { start: '09:00', end: '16:00', days: 'weekdays' },
      intradayInterval: '15m',
      decimals: 0,
      hasVolume: true,
    });
    // The search is narrowed to the symbol's exchange.
    expect(requests.find((u) => u.pathname === '/api/search/PRDA')?.searchParams.get('exchange')).toBe('JK');
  });

  it('falls back to the legacy exchange details, and follows virtual exchanges around the clock on UTC', async () => {
    routes['/api/real-time/AAPL.US'] = { ...prdaQuote, close: 230.5 };
    routes['/api/eod/AAPL.US'] = [{ ...prdaDays[1], close: 230.5 }];
    routes['/api/exchange-details/US'] = { Name: 'USA Stocks', Timezone: 'America/New_York', TradingHours: { Open: '09:30:00', Close: '16:00:00', WorkingDays: 'Mon,Tue,Wed,Thu,Fri' } };
    expect(await new EodhdStockProvider().lookup('AAPL.US')).toMatchObject({ timeZone: 'America/New_York', session: { start: '09:30', end: '16:00' }, decimals: 2 });

    routes['/api/real-time/BTC-USD.CC'] = { ...prdaQuote, close: 67_123.45 };
    routes['/api/eod/BTC-USD.CC'] = [{ ...prdaDays[1], close: 67_123.45 }];
    const btc = await new EodhdStockProvider().lookup('BTC-USD.CC');
    expect(btc).toMatchObject({ type: 'CRYPTOCURRENCY', timeZone: 'UTC', session: { start: '00:00', end: '23:59', days: 'daily' } });
    expect(requests.some((u) => u.pathname.includes('exchange-details/CC'))).toBe(false);
  });

  it('says when it has no data for a symbol, and never shows the API key in errors', async () => {
    await expect(new EodhdStockProvider().lookup('NOPE.JK')).rejects.toThrow('EODHD has no data for NOPE.JK');
    routes['/api/real-time/PRDA.JK'] = reply(401, { error: 'Unauthenticated' });
    const err = await new EodhdStockProvider().quote({ id: 'eodhd:PRDA.JK', symbol: 'PRDA.JK' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 401');
    expect((err as Error).message).toContain('api_token=<EODHD_API_KEY>');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('quotes an asset under its ID (missing values come as "NA")', async () => {
    routes['/api/real-time/PRDA.JK'] = { ...prdaQuote, previousClose: 'NA', change: 'NA', change_p: 'NA' };
    expect(await new EodhdStockProvider().quote({ id: 'eodhd:PRDA.JK', symbol: 'PRDA.JK' })).toMatchObject({
      asset: 'eodhd:PRDA.JK',
      price: 2900,
      previousClose: null,
      change: null,
      marketTime: new Date(1_792_565_400_000).toISOString(),
    });
    routes['/api/real-time/PRDA.JK'] = { code: 'PRDA.JK', close: 'NA' };
    expect(await new EodhdStockProvider().quote({ id: 'eodhd:PRDA.JK', symbol: 'PRDA.JK' })).toBeNull();
  });

  it('searches in its own symbol format', async () => {
    routes['/api/search/prodia'] = [
      { Code: 'PRDA', Exchange: 'JK', Name: 'Prodia Widyahusada Tbk PT', Type: 'Common Stock', Country: 'Indonesia', Currency: 'IDR' },
      { Code: 'bad code!', Exchange: 'JK', Name: 'Not a symbol' },
    ];
    expect(await new EodhdStockProvider().search('prodia')).toEqual([
      { id: 'eodhd:PRDA.JK', source: 'eodhd', symbol: 'PRDA.JK', name: 'Prodia Widyahusada Tbk PT', exchange: 'JK · Indonesia', type: 'EQUITY', currency: 'IDR' },
    ]);
  });

  it('asks for 5-minute bars from a UNIX time and rolls them into 15-minute bars', async () => {
    const t0 = 1_792_548_000; // 2026-10-21 09:00 WIB
    routes['/api/intraday/PRDA.JK'] = [0, 300, 600, 900].map((s, i) => ({ timestamp: t0 + s, open: 2880 + i, high: 2890 + i, low: 2870, close: 2885 + i, volume: 1000 }));
    routes['/api/real-time/PRDA.JK'] = prdaQuote;
    const { candles, quote } = await new EodhdStockProvider().intraday({ id: 'eodhd:PRDA.JK', symbol: 'PRDA.JK' }, new Date(t0 * 1000));
    expect(requests.find((u) => u.pathname === '/api/intraday/PRDA.JK')?.searchParams.get('from')).toBe(String(t0));
    expect(candles).toEqual([
      { time: t0, open: 2880, high: 2892, low: 2870, close: 2887, volume: 3000 },
      { time: t0 + 900, open: 2883, high: 2893, low: 2870, close: 2888, volume: 1000 },
    ]);
    expect(quote?.asset).toBe('eodhd:PRDA.JK');
  });

  it("maps EODHD's instrument types and decimals", () => {
    expect(instrumentType('Common Stock', 'JK')).toBe('EQUITY');
    expect(instrumentType('ETF', 'US')).toBe('ETF');
    expect(instrumentType('FUND', 'US')).toBe('MUTUALFUND');
    expect(instrumentType(undefined, 'FOREX')).toBe('CURRENCY');
    expect(instrumentType('Unit', 'JK')).toBe('UNIT');
    expect(decimalsOf([2900, 2850])).toBe(0);
    expect(decimalsOf([1.0832, 1.08])).toBe(4);
    expect(decimalsOf([230.5])).toBe(2);
  });
});
