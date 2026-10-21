import type { StockAsset } from '@bio-majesty/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 86_400_000;
const fetched: { kind: 'daily' | 'intraday' | 'lookup'; symbol: string; daysBack?: number }[] = [];
const checks: { kind: 'eod' | 'intraday'; sub: string; symbol: string }[] = [];
const statuses = new Map<string, { historyLoadedAt: string | null; eodDoneFor: string | null; consecutiveFailures: number }>();
const state = { intradayFails: false };

const idx: StockAsset = {
  symbol: 'PRDA.JK',
  name: 'PT Prodia Widyahusada Tbk',
  exchange: 'Jakarta',
  type: 'EQUITY',
  currency: 'IDR',
  timeZone: 'Asia/Jakarta',
  session: { start: '09:00', end: '16:15', days: 'weekdays' },
  intradayInterval: '15m',
  decimals: 0,
  hasVolume: true,
  firstTradeDate: '2016-12-09T02:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const assets = new Map<string, StockAsset>();

const snapshot = (n: number) => ({ candles: Array.from({ length: n }, (_, i) => ({ time: i, open: 1, high: 1, low: 1, close: 1, volume: 1 })), quote: null });
const daysBack = (from: Date) => Math.round((Date.now() - from.getTime()) / DAY);

vi.mock('../src/lib/accounts', () => ({ listAccounts: async () => [{ sub: 'u1', email: null }, { sub: 'u2', email: null }] }));
vi.mock('../src/repo/settings', () => ({
  getSettings: async (sub: string) => ({ stock: { symbols: sub === 'u1' ? ['PRDA.JK'] : ['PRDA.JK', 'BTC-USD'], volumeRatio: 3 } }),
}));
vi.mock('../src/stock/anomalies', () => ({
  checkEodVolume: async (sub: string, a: StockAsset) => void checks.push({ kind: 'eod', sub, symbol: a.symbol }),
  checkIntradayVolume: async (sub: string, a: StockAsset) => void checks.push({ kind: 'intraday', sub, symbol: a.symbol }),
}));
vi.mock('../src/notify/notify', () => ({ notifyAccount: async () => true }));
vi.mock('../src/repo/stock', () => ({
  INTRADAY_RETENTION_DAYS: 10,
  getAsset: async (symbol: string) => assets.get(symbol) ?? null,
  putAsset: async (a: StockAsset) => void assets.set(a.symbol, a),
  getStockStatus: async (symbol: string) => ({ lastSuccessAt: null, lastError: null, ...(statuses.get(symbol) ?? { historyLoadedAt: null, eodDoneFor: null, consecutiveFailures: 0 }) }),
  putStockStatus: async (symbol: string, s: { historyLoadedAt: string | null; eodDoneFor: string | null; consecutiveFailures: number }) => void statuses.set(symbol, s),
  putQuote: async () => undefined,
  putDailyCandles: async () => undefined,
  putIntradayCandles: async () => undefined,
}));
vi.mock('../src/stock', async (original) => ({
  ...(await original<typeof import('../src/stock')>()),
  stockProvider: () => ({
    name: 'test',
    lookup: async (symbol: string) => {
      fetched.push({ kind: 'lookup', symbol });
      return symbol === 'BTC-USD'
        ? { ...idx, symbol, type: 'CRYPTOCURRENCY', timeZone: 'UTC', session: { start: '00:00', end: '23:59', days: 'daily' }, firstTradeDate: null }
        : idx;
    },
    daily: async (a: StockAsset, from: Date) => (fetched.push({ kind: 'daily', symbol: a.symbol, daysBack: daysBack(from) }), snapshot(10)),
    intraday: async (symbol: string, from: Date) => {
      fetched.push({ kind: 'intraday', symbol, daysBack: daysBack(from) });
      if (state.intradayFails) throw new Error('no 15m data');
      return snapshot(5);
    },
  }),
}));

const { handler } = await import('../src/handlers/stock-ingest');

/** Both symbols already loaded; BTC-USD's end-of-day passes are done, PRDA.JK's up to `prdaEodDone`. */
function loaded(prdaEodDone: string) {
  assets.set('PRDA.JK', idx);
  assets.set('BTC-USD', { ...idx, symbol: 'BTC-USD', type: 'CRYPTOCURRENCY', timeZone: 'UTC', session: { start: '00:00', end: '23:59', days: 'daily' } });
  statuses.set('PRDA.JK', { historyLoadedAt: '2026-10-01T00:00:00Z', eodDoneFor: prdaEodDone, consecutiveFailures: 0 });
  statuses.set('BTC-USD', { historyLoadedAt: '2026-10-01T00:00:00Z', eodDoneFor: '2026-10-20', consecutiveFailures: 0 });
}

describe('stock refresh tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetched.length = 0;
    checks.length = 0;
    assets.clear();
    statuses.clear();
    state.intradayFails = false;
  });
  afterEach(() => vi.useRealTimers());

  it("fetches the last two days of intraday bars while each asset's market is open, once per symbol", async () => {
    vi.setSystemTime(new Date('2026-10-21T05:00:00Z')); // Wednesday, 12:00 in Jakarta
    loaded('2026-10-20');
    expect(await handler({ mode: 'tick' })).toEqual({ refreshed: ['PRDA.JK', 'BTC-USD'] });
    expect(fetched).toEqual([
      { kind: 'intraday', symbol: 'PRDA.JK', daysBack: 2 },
      { kind: 'intraday', symbol: 'BTC-USD', daysBack: 2 },
    ]);
    // Each account tracking a symbol gets its own volume check.
    expect(checks).toEqual([
      { kind: 'intraday', sub: 'u1', symbol: 'PRDA.JK' },
      { kind: 'intraday', sub: 'u2', symbol: 'PRDA.JK' },
      { kind: 'intraday', sub: 'u2', symbol: 'BTC-USD' },
    ]);
  });

  it('runs the end-of-day refresh once after the close: two weeks of daily bars and a week of intraday bars', async () => {
    vi.setSystemTime(new Date('2026-10-21T10:30:00Z')); // 17:30 in Jakarta
    loaded('2026-10-20');
    await handler({ mode: 'tick' });
    expect(fetched.filter((f) => f.symbol === 'PRDA.JK')).toEqual([
      { kind: 'daily', symbol: 'PRDA.JK', daysBack: 15 },
      { kind: 'intraday', symbol: 'PRDA.JK', daysBack: 7 },
    ]);
    expect(statuses.get('PRDA.JK')?.eodDoneFor).toBe('2026-10-21');
    fetched.length = 0;
    await handler({ mode: 'tick' });
    expect(fetched.filter((f) => f.symbol === 'PRDA.JK')).toEqual([]);
  });

  it('loads the full history (and asks for metadata) the first time it sees a symbol', async () => {
    vi.setSystemTime(new Date('2026-10-24T05:00:00Z')); // Saturday
    await handler({ mode: 'tick' });
    const prda = fetched.filter((f) => f.symbol === 'PRDA.JK');
    expect(prda[0]).toEqual({ kind: 'lookup', symbol: 'PRDA.JK' });
    expect(prda[1]).toMatchObject({ kind: 'daily' });
    expect(prda[1]!.daysBack).toBeGreaterThan(3600); // since the first trade in 2016
    expect(prda[2]).toEqual({ kind: 'intraday', symbol: 'PRDA.JK', daysBack: 10 });
    // Friday's session is in that history, so no end-of-day pass is due right after.
    expect(statuses.get('PRDA.JK')).toMatchObject({ eodDoneFor: '2026-10-23', historyLoadedAt: '2026-10-24T05:00:00.000Z' });
  });

  it('a failing intraday refill does not fail the daily refresh', async () => {
    vi.setSystemTime(new Date('2026-10-21T10:30:00Z'));
    loaded('2026-10-20');
    state.intradayFails = true;
    await handler({ mode: 'tick' });
    expect(statuses.get('PRDA.JK')).toMatchObject({ eodDoneFor: '2026-10-21', consecutiveFailures: 0 });
  });

  it('resyncs one symbol on request', async () => {
    vi.setSystemTime(new Date('2026-10-21T05:00:00Z'));
    loaded('2026-10-20');
    expect(await handler({ mode: 'resync', symbol: 'BTC-USD' })).toEqual({ refreshed: ['BTC-USD'] });
    expect(fetched.map((f) => f.kind)).toEqual(['lookup', 'daily', 'intraday']);
  });
});
