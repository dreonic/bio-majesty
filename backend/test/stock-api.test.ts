import type { Candle, StockAsset, StockAssetsResponse, StockExportResponse } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STOCK_INGEST_FUNCTION = 'stock-ingest';

const bar = (iso: string, i: number): Candle => ({ time: Date.parse(iso) / 1000, open: 100 + i, high: 110, low: 90, close: 105, volume: 1000 + i });
const daily = [bar('2016-12-09T00:00:00Z', 0), bar('2026-10-15T00:00:00Z', 1)];
const live = [bar('2026-08-24T02:00:00Z', 0), bar('2026-10-16T02:15:00Z', 1)];
const calls: { kind: string; from: string }[] = [];
const invoked: unknown[] = [];

const asset = (symbol: string, overrides: Partial<StockAsset> = {}): StockAsset => ({
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
});
const assets = new Map<string, StockAsset>([
  ['PRDA.JK', asset('PRDA.JK')],
  ['VFIAX', asset('VFIAX', { type: 'MUTUALFUND', intradayInterval: null, timeZone: 'America/New_York' })],
]);
let settings: { stock: { symbols: string[]; volumeRatio: number }; profile: { sentimentSymbol: string | null } };

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
  getAsset: async (symbol: string) => assets.get(symbol) ?? null,
  getAssets: async (symbols: string[]) => symbols.flatMap((s) => assets.get(s) ?? []),
  putAsset: async (a: StockAsset) => void assets.set(a.symbol, a),
}));
vi.mock('../src/stock', async (original) => ({
  ...(await original<typeof import('../src/stock')>()),
  stockProvider: () => ({
    name: 'test',
    lookup: async (symbol: string) => {
      if (symbol === 'NOPE') throw new Error('No data found, symbol may be delisted');
      return asset(symbol, { type: 'CRYPTOCURRENCY', timeZone: 'UTC', decimals: 2 });
    },
    intraday: async (_: string, from: Date) => (calls.push({ kind: 'live-intraday', from: from.toISOString() }), { candles: live, quote: null }),
  }),
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

beforeEach(() => {
  calls.length = 0;
  invoked.length = 0;
  settings = { stock: { symbols: ['PRDA.JK', 'VFIAX'], volumeRatio: 3 }, profile: { sentimentSymbol: 'PRDA.JK' } };
});

describe('GET /stock/export', () => {
  const exportCsv = (query: Record<string, string>) => call('GET', '/stock/export', { query });

  it('exports every stored daily bar since the first trade', async () => {
    const body = JSON.parse((await exportCsv({ symbol: 'PRDA.JK', interval: '1d' })).body) as StockExportResponse;
    expect(calls).toEqual([{ kind: 'daily', from: '2016-12-09T02:00:00.000Z' }]);
    expect(body).toMatchObject({ filename: 'PRDA.JK_daily_2016-12-09_2026-10-15.csv', rows: 2 });
    expect(body.csv.split('\r\n')[1]).toBe('2016-12-09,100,110,90,105,1000');
  });

  it("downloads the source's intraday bars (the last 60 days) on the exec's clock", async () => {
    const body = JSON.parse((await exportCsv({ symbol: 'prda.jk', interval: 'intraday' })).body) as StockExportResponse;
    expect(calls.map((c) => c.kind)).toEqual(['live-intraday']);
    expect(Math.round((Date.now() - Date.parse(calls[0]!.from)) / 86_400_000)).toBe(59);
    expect(body).toMatchObject({ filename: 'PRDA.JK_15min_2026-08-24_2026-10-16.csv', rows: 2 });
    expect(body.csv.split('\r\n').slice(0, 2)).toEqual(['Time (SGT),Open,High,Low,Close,Volume', '2026-08-24 10:00,100,110,90,105,1000']);
  });

  it('has no intraday download for daily-only assets', async () => {
    expect((await exportCsv({ symbol: 'VFIAX', interval: 'intraday' })).statusCode).toBe(400);
  });

  it("serves only the account's own assets and known intervals", async () => {
    expect((await exportCsv({ symbol: 'AAPL', interval: '1d' })).statusCode).toBe(404);
    expect((await exportCsv({ symbol: 'PRDA.JK' })).statusCode).toBe(400);
    expect((await exportCsv({ symbol: 'PRDA.JK', interval: '1wk' })).statusCode).toBe(400);
  });
});

describe('/stock/assets', () => {
  it('adds a looked-up symbol and loads its history in the background', async () => {
    const res = await call('POST', '/stock/assets', { body: { symbol: 'btc-usd' } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as StockAssetsResponse;
    expect(body.items.map((a) => a.symbol)).toEqual(['PRDA.JK', 'VFIAX', 'BTC-USD']);
    expect(settings.stock.symbols).toEqual(['PRDA.JK', 'VFIAX', 'BTC-USD']);
    expect(invoked).toEqual([{ mode: 'resync', symbol: 'BTC-USD' }]);
  });

  it('refuses unknown, duplicate and malformed symbols', async () => {
    expect((await call('POST', '/stock/assets', { body: { symbol: 'NOPE' } })).statusCode).toBe(400);
    expect((await call('POST', '/stock/assets', { body: { symbol: 'PRDA.JK' } })).statusCode).toBe(409);
    expect((await call('POST', '/stock/assets', { body: { symbol: 'not a symbol!' } })).statusCode).toBe(400);
    expect(settings.stock.symbols).toEqual(['PRDA.JK', 'VFIAX']);
  });

  it('keeps the asset sentiment is judged against', async () => {
    expect((await call('DELETE', '/stock/assets/{symbol}', { path: { symbol: 'PRDA.JK' } })).statusCode).toBe(400);
    const res = await call('DELETE', '/stock/assets/{symbol}', { path: { symbol: 'VFIAX' } });
    expect(res.statusCode).toBe(200);
    expect(settings.stock.symbols).toEqual(['PRDA.JK']);
  });
});
