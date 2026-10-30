import type { Candle, StockAsset, StockAssetsResponse, StockExportResponse, StockSearchResponse, StockSource, SymbolMatch } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STOCK_INGEST_FUNCTION = 'stock-ingest';

const bar = (iso: string, i: number): Candle => ({ time: Date.parse(iso) / 1000, open: 100 + i, high: 110, low: 90, close: 105, volume: 1000 + i });
const daily = [bar('2016-12-09T00:00:00Z', 0), bar('2026-10-15T00:00:00Z', 1)];
const live = [bar('2026-08-24T02:00:00Z', 0), bar('2026-10-16T02:15:00Z', 1)];
const calls: { kind: string; from: string; source?: StockSource }[] = [];
const invoked: unknown[] = [];
const configured: { sources: StockSource[] } = { sources: ['yahoo'] };

const asset = (id: string, overrides: Partial<StockAsset> = {}): StockAsset => {
  const [source, symbol] = id.split(':') as [StockSource, string];
  return {
    id,
    source,
    symbol,
    name: null,
    exchange: 'Jakarta',
    type: 'EQUITY',
    currency: 'IDR',
    timeZone: 'Asia/Jakarta',
    session: { start: '09:00', end: '16:15', days: 'weekdays' },
    intradayInterval: '15m',
    decimals: 0,
    hasVolume: true,
    firstTradeDate: '2016-12-09T02:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
};
const assets = new Map<string, StockAsset>();
let settings: { stock: { assets: string[]; volumeRatio: number }; subject: { sentimentAsset: string | null } };

vi.mock('../src/repo/settings', () => ({
  getSettings: async () => settings,
  saveSettings: async (_sub: string, next: typeof settings) => (settings = next),
}));
vi.mock('../src/lib/aws', () => ({ invokeAsync: async (_fn: string, payload: unknown) => void invoked.push(payload) }));
vi.mock('../src/repo/stock', () => ({
  queryDaily: async (_: string, from: Date) => (calls.push({ kind: 'daily', from: from.toISOString() }), daily),
  queryIntraday: async (_: string, from: Date) => (calls.push({ kind: 'stored-intraday', from: from.toISOString() }), []),
  getQuote: async () => null,
  getStockStatus: async () => ({ lastSuccessAt: null, lastError: null, consecutiveFailures: 0, historyLoadedAt: null, eodDoneFor: null }),
  listAnomalyRecords: async () => [],
  getAsset: async (id: string) => assets.get(id) ?? null,
  getAssets: async (ids: string[]) => ids.flatMap((id) => assets.get(id) ?? []),
  putAsset: async (a: StockAsset) => void assets.set(a.id, a),
}));
/** A source that knows ACME.JK (and suggests it for "ACME"), and anything else except NOPE. */
const fakeProvider = (source: StockSource) => ({
  source,
  lookup: async (symbol: string) => {
    if (symbol === 'NOPE' || symbol === 'ACME') throw new Error('No data found, symbol may be delisted');
    return asset(`${source}:${symbol}`, { type: 'CRYPTOCURRENCY', timeZone: 'UTC', decimals: 2 });
  },
  search: async (q: string): Promise<SymbolMatch[]> =>
    q === 'ACME' ? [{ id: `${source}:ACME.JK`, source, symbol: 'ACME.JK', name: 'PT Acme Laboratorium Tbk', exchange: 'Jakarta', type: 'EQUITY', currency: 'IDR' }] : [],
  intraday: async (_: StockAsset, from: Date) => (calls.push({ kind: 'live-intraday', from: from.toISOString(), source }), { candles: live, quote: null }),
});
vi.mock('../src/stock', async (original) => ({
  ...(await original<typeof import('../src/stock')>()),
  configuredSources: async () => configured.sources,
  stockProvider: (source: StockSource) => fakeProvider(source),
}));

const { handler } = await import('../src/handlers/api/stock');

const call = (method: string, resource: string, opts: { query?: Record<string, string>; body?: unknown; path?: Record<string, string> } = {}) =>
  handler({
    httpMethod: method,
    resource,
    headers: {},
    queryStringParameters: opts.query ?? null,
    pathParameters: opts.path ?? null,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    requestContext: { authorizer: { claims: { sub: 'u1', 'cognito:groups': 'dashboard-users' } } },
  } as unknown as APIGatewayProxyEvent);
const bodyOf = <T>(res: { body: string }) => JSON.parse(res.body) as T;

beforeEach(() => {
  calls.length = 0;
  invoked.length = 0;
  configured.sources = ['yahoo'];
  assets.clear();
  assets.set('yahoo:ACME.JK', asset('yahoo:ACME.JK'));
  assets.set('yahoo:VFIAX', asset('yahoo:VFIAX', { type: 'MUTUALFUND', intradayInterval: null, timeZone: 'America/New_York' }));
  assets.set('eodhd:ACME.JK', asset('eodhd:ACME.JK'));
  settings = { stock: { assets: ['yahoo:ACME.JK', 'yahoo:VFIAX', 'eodhd:ACME.JK'], volumeRatio: 3 }, subject: { sentimentAsset: 'yahoo:ACME.JK' } };
});

describe('GET /stock/export', () => {
  const exportCsv = (query: Record<string, string>) => call('GET', '/stock/export', { query });
  const daysBack = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / 86_400_000);

  it('exports every stored daily bar since the first trade', async () => {
    const body = bodyOf<StockExportResponse>(await exportCsv({ asset: 'yahoo:ACME.JK', interval: '1d' }));
    expect(calls).toEqual([{ kind: 'daily', from: '2016-12-09T02:00:00.000Z' }]);
    expect(body).toMatchObject({ filename: 'ACME.JK_daily_2016-12-09_2026-10-15.csv', rows: 2 });
    expect(body.csv.split('\r\n')[1]).toBe('2016-12-09,100,110,90,105,1000');
  });

  it("downloads the intraday bars the asset's own source still has, on the exec's clock", async () => {
    const body = bodyOf<StockExportResponse>(await exportCsv({ asset: 'Yahoo:acme.jk', interval: 'intraday' }));
    expect(calls).toMatchObject([{ kind: 'live-intraday', source: 'yahoo' }]);
    expect(daysBack(calls[0]!.from)).toBe(59); // Yahoo serves 60 days
    expect(body).toMatchObject({ filename: 'ACME.JK_15min_2026-08-24_2026-10-16.csv', rows: 2 });
    expect(body.csv.split('\r\n').slice(0, 2)).toEqual(['Time (SGT),Open,High,Low,Close,Volume', '2026-08-24 10:00,100,110,90,105,1000']);

    calls.length = 0;
    await exportCsv({ asset: 'eodhd:ACME.JK', interval: 'intraday' });
    expect(calls).toMatchObject([{ kind: 'live-intraday', source: 'eodhd' }]);
    expect(daysBack(calls[0]!.from)).toBe(119);
  });

  it('has no intraday download for daily-only assets', async () => {
    expect((await exportCsv({ asset: 'yahoo:VFIAX', interval: 'intraday' })).statusCode).toBe(400);
  });

  it("serves only the account's own assets and known intervals", async () => {
    expect((await exportCsv({ asset: 'yahoo:AAPL', interval: '1d' })).statusCode).toBe(404);
    expect((await exportCsv({ asset: 'ACME.JK', interval: '1d' })).statusCode).toBe(400); // no source
    expect((await exportCsv({ asset: 'yahoo:ACME.JK' })).statusCode).toBe(400);
    expect((await exportCsv({ asset: 'yahoo:ACME.JK', interval: '1wk' })).statusCode).toBe(400);
  });
});

describe('/stock/assets', () => {
  const add = (body: unknown) => call('POST', '/stock/assets', { body });

  it('lists the assets with the sources new ones can come from', async () => {
    configured.sources = ['yahoo', 'eodhd'];
    const body = bodyOf<StockAssetsResponse>(await call('GET', '/stock/assets'));
    expect(body.items.map((a) => a.id)).toEqual(['yahoo:ACME.JK', 'yahoo:VFIAX', 'eodhd:ACME.JK']);
    expect(body.sources).toEqual(['yahoo', 'eodhd']);
  });

  it('adds a looked-up symbol and loads its history in the background', async () => {
    const res = await add({ source: 'yahoo', symbol: 'btc-usd' });
    expect(res.statusCode).toBe(201);
    expect(bodyOf<StockAssetsResponse>(res).items.map((a) => a.id)).toEqual(['yahoo:ACME.JK', 'yahoo:VFIAX', 'eodhd:ACME.JK', 'yahoo:BTC-USD']);
    expect(settings.stock.assets).toEqual(['yahoo:ACME.JK', 'yahoo:VFIAX', 'eodhd:ACME.JK', 'yahoo:BTC-USD']);
    expect(invoked).toEqual([{ mode: 'resync', asset: 'yahoo:BTC-USD' }]);
  });

  it('refuses unknown, duplicate and malformed symbols, suggesting what the source has', async () => {
    expect((await add({ source: 'yahoo', symbol: 'NOPE' })).statusCode).toBe(400);
    const near = await add({ source: 'yahoo', symbol: 'acme' });
    expect(near.statusCode).toBe(400);
    expect(bodyOf<{ message: string }>(near).message).toMatch(/^No Yahoo Finance data for ACME \(.*\)\. Did you mean ACME\.JK \(PT Acme Laboratorium Tbk\)\?$/);
    expect((await add({ source: 'yahoo', symbol: 'ACME.JK' })).statusCode).toBe(409);
    expect((await add({ source: 'yahoo', symbol: 'not a symbol!' })).statusCode).toBe(400);
    expect((await add({ source: 'google', symbol: 'ACME.JK' })).statusCode).toBe(400);
    expect(settings.stock.assets).toHaveLength(3);
  });

  it('adds from another source only once its API key is set, in its own format', async () => {
    settings.stock.assets = ['yahoo:ACME.JK'];
    const notSetUp = await add({ source: 'eodhd', symbol: 'AAPL.US' });
    expect(notSetUp.statusCode).toBe(400);
    expect(bodyOf<{ message: string }>(notSetUp).message).toBe('EODHD is not set up: add EODHD_API_KEY to the API keys parameter first');
    configured.sources = ['yahoo', 'eodhd'];
    expect((await add({ source: 'eodhd', symbol: 'AAPL' })).statusCode).toBe(400); // EODHD needs the exchange code
    // The same ticker from another source is another asset, with its own history.
    expect((await add({ source: 'eodhd', symbol: 'ACME.JK' })).statusCode).toBe(201);
    expect(settings.stock.assets).toEqual(['yahoo:ACME.JK', 'eodhd:ACME.JK']);
  });

  it('keeps the asset sentiment is judged against', async () => {
    const remove = (asset: string) => call('DELETE', '/stock/assets', { query: { asset } });
    expect((await remove('yahoo:ACME.JK')).statusCode).toBe(400);
    expect((await remove('yahoo:VFIAX')).statusCode).toBe(200);
    expect(settings.stock.assets).toEqual(['yahoo:ACME.JK', 'eodhd:ACME.JK']);
    expect((await remove('yahoo:VFIAX')).statusCode).toBe(404);
  });
});

describe('GET /stock/search', () => {
  const search = (query: Record<string, string>) => call('GET', '/stock/search', { query });

  it("returns the source's matches", async () => {
    const res = await search({ source: 'yahoo', q: 'ACME' });
    expect(res.statusCode).toBe(200);
    expect(bodyOf<StockSearchResponse>(res).items).toMatchObject([{ id: 'yahoo:ACME.JK', name: 'PT Acme Laboratorium Tbk' }]);
  });

  it('needs a set-up source and at least two characters', async () => {
    expect((await search({ source: 'eodhd', q: 'ACME' })).statusCode).toBe(400);
    expect((await search({ source: 'yahoo', q: 'P' })).statusCode).toBe(400);
  });
});
