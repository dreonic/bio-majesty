import { beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 86_400_000;
const state = { historyLoadedAt: '2026-10-01T00:00:00Z' as string | null, intradayFails: false };
const fetched: { kind: 'daily' | 'intraday'; daysBack: number }[] = [];
const stored = { daily: 0, intraday: 0 };

const snapshot = (n: number) => ({ candles: Array.from({ length: n }, (_, i) => ({ time: i, open: 1, high: 1, low: 1, close: 1, volume: 1 })), quote: null });
const daysBack = (from: Date) => Math.round((Date.now() - from.getTime()) / DAY);

vi.mock('../src/repo/settings', () => ({ getSettings: async () => ({ stock: { symbol: 'PRDA.JK', volumeRatio: 3 } }) }));
vi.mock('../src/stock/anomalies', () => ({ checkEodVolume: async () => null, checkIntradayVolume: async () => null }));
vi.mock('../src/notify/notify', () => ({ notifyExec: async () => undefined }));
vi.mock('../src/repo/stock', () => ({
  getStockStatus: async () => ({ lastSuccessAt: null, lastError: null, consecutiveFailures: 0, historyLoadedAt: state.historyLoadedAt }),
  putStockStatus: async () => undefined,
  putQuote: async () => undefined,
  putDailyCandles: async (_: string, c: unknown[]) => void (stored.daily += c.length),
  putIntradayCandles: async (_: string, c: unknown[]) => void (stored.intraday += c.length),
}));
vi.mock('../src/stock', () => ({
  HISTORY_START: new Date('2016-12-01T00:00:00Z'),
  stockProvider: () => ({
    name: 'test',
    daily: async (_: string, from: Date) => (fetched.push({ kind: 'daily', daysBack: daysBack(from) }), snapshot(10)),
    intraday: async (_: string, from: Date) => {
      fetched.push({ kind: 'intraday', daysBack: daysBack(from) });
      if (state.intradayFails) throw new Error('no 15m data');
      return snapshot(5);
    },
  }),
}));

const { handler } = await import('../src/handlers/stock-ingest');

describe('stock ingest keeps 15-minute bars filled in', () => {
  beforeEach(() => {
    fetched.length = 0;
    stored.daily = stored.intraday = 0;
    state.historyLoadedAt = '2026-10-01T00:00:00Z';
    state.intradayFails = false;
  });

  it('the 15-minute run fetches the last two days', async () => {
    await handler({ mode: 'intraday' });
    expect(fetched).toEqual([{ kind: 'intraday', daysBack: 2 }]);
  });

  it('the end-of-day run also re-fetches the last week of 15-minute bars', async () => {
    expect(await handler({ mode: 'eod' })).toEqual({ candles: 15 });
    expect(fetched).toEqual([
      { kind: 'daily', daysBack: 15 },
      { kind: 'intraday', daysBack: 7 },
    ]);
    expect(stored).toEqual({ daily: 10, intraday: 5 });
  });

  it("a resync (and the first run) loads the ~60 days of 15-minute bars Yahoo keeps", async () => {
    state.historyLoadedAt = null;
    await handler({ mode: 'intraday' });
    expect(fetched[1]).toEqual({ kind: 'intraday', daysBack: 59 });
  });

  it('a failing 15-minute refill does not fail the daily refresh', async () => {
    state.intradayFails = true;
    expect(await handler({ mode: 'eod' })).toEqual({ candles: 10 });
    expect(stored).toEqual({ daily: 10, intraday: 0 });
  });
});
