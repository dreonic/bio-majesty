import type { Candle, StockExportResponse } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

const bar = (iso: string, i: number): Candle => ({ time: Date.parse(iso) / 1000, open: 100 + i, high: 110, low: 90, close: 105, volume: 1000 + i });
const daily = [bar('2016-12-09T00:00:00Z', 0), bar('2026-10-15T00:00:00Z', 1)];
const intraday = [bar('2026-08-18T02:00:00Z', 0), bar('2026-10-16T02:15:00Z', 1)];
const calls: { kind: string; from: string }[] = [];

vi.mock('../src/repo/settings', () => ({ getSettings: async () => ({ stock: { symbol: 'PRDA.JK', volumeRatio: 3 } }) }));
vi.mock('../src/repo/articles', () => ({ listArticles: async () => ({ items: [], nextCursor: null }) }));
vi.mock('../src/lib/aws', () => ({ invokeAsync: async () => undefined }));
vi.mock('../src/repo/stock', () => ({
  queryDaily: async (_: string, from: Date) => (calls.push({ kind: 'daily', from: from.toISOString() }), daily),
  queryIntraday: async (_: string, from: Date) => (calls.push({ kind: 'intraday', from: from.toISOString() }), intraday),
  getQuote: async () => null,
  getStockStatus: async () => ({ lastSuccessAt: null, lastError: null, consecutiveFailures: 0, historyLoadedAt: null }),
  listAnomalyRecords: async () => [],
}));

const { handler } = await import('../src/handlers/api/stock');

const request = (query: Record<string, string>) =>
  handler({
    httpMethod: 'GET',
    resource: '/stock/export',
    headers: {},
    queryStringParameters: query,
    requestContext: { authorizer: { claims: { sub: 'u1', 'cognito:groups': 'dashboard-users' } } },
  } as unknown as APIGatewayProxyEvent);

describe('GET /stock/export', () => {
  it('exports every daily bar since listing', async () => {
    calls.length = 0;
    const res = await request({ interval: '1d' });
    const body = JSON.parse(res.body) as StockExportResponse;
    expect(calls).toEqual([{ kind: 'daily', from: '2016-12-01T00:00:00.000Z' }]);
    expect(body).toMatchObject({ filename: 'PRDA.JK_daily_2016-12-09_2026-10-15.csv', rows: 2 });
    expect(body.csv.split('\r\n')[1]).toBe('2016-12-09,100,110,90,105,1000');
  });

  it("exports every stored 15-minute bar on the exec's clock, whatever the chart shows", async () => {
    calls.length = 0;
    const body = JSON.parse((await request({ interval: '15m' })).body) as StockExportResponse;
    expect(calls).toEqual([{ kind: 'intraday', from: '1970-01-01T00:00:00.000Z' }]);
    expect(body).toMatchObject({ filename: 'PRDA.JK_15min_2026-08-18_2026-10-16.csv', rows: 2 });
    expect(body.csv.split('\r\n').slice(0, 2)).toEqual(['Time (SGT),Open,High,Low,Close,Volume', '2026-08-18 10:00,100,110,90,105,1000']);
  });

  it('needs a known interval', async () => {
    expect((await request({})).statusCode).toBe(400);
    expect((await request({ interval: '1wk' })).statusCode).toBe(400);
  });
});
