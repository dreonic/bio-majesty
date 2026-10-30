import type { StockAsset, StockSource } from '@bio-majesty/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 86_400_000;
const fetched: { kind: 'daily' | 'intraday' | 'quote' | 'lookup'; asset: string; daysBack?: number }[] = [];
const checks: { kind: 'eod' | 'intraday'; profileId: string; asset: string }[] = [];
const statuses = new Map<string, { historyLoadedAt: string | null; eodDoneFor: string | null; consecutiveFailures: number }>();
const state = { intradayFails: false };

const idx: StockAsset = {
  id: 'yahoo:ACME.JK',
  source: 'yahoo',
  symbol: 'ACME.JK',
  name: 'PT Acme Laboratorium Tbk',
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
const btc: StockAsset = { ...idx, id: 'yahoo:BTC-USD', symbol: 'BTC-USD', type: 'CRYPTOCURRENCY', timeZone: 'UTC', session: { start: '00:00', end: '23:59', days: 'daily' } };
const eodhdIdx: StockAsset = { ...idx, id: 'eodhd:ACME.JK', source: 'eodhd' };
const assets = new Map<string, StockAsset>();
const profileAssets: Record<string, string[]> = {};

const snapshot = (n: number) => ({ candles: Array.from({ length: n }, (_, i) => ({ time: i, open: 1, high: 1, low: 1, close: 1, volume: 1 })), quote: null });
const daysBack = (from: Date) => Math.round((Date.now() - from.getTime()) / DAY);

vi.mock('../src/lib/accounts', () => ({ listAllProfiles: async () => Object.keys(profileAssets).map((profileId) => ({ sub: 'u1', profileId })) }));
vi.mock('../src/repo/settings', () => ({
  getSettings: async (profileId: string) => ({ stock: { assets: profileAssets[profileId] ?? [], volumeRatio: 3 } }),
}));
vi.mock('../src/stock/anomalies', () => ({
  checkEodVolume: async (profileId: string, a: StockAsset) => void checks.push({ kind: 'eod', profileId, asset: a.id }),
  checkIntradayVolume: async (profileId: string, a: StockAsset) => void checks.push({ kind: 'intraday', profileId, asset: a.id }),
}));
vi.mock('../src/notify/notify', () => ({ notifyProfile: async () => true }));
vi.mock('../src/repo/stock', () => ({
  INTRADAY_RETENTION_DAYS: 10,
  getAsset: async (id: string) => assets.get(id) ?? null,
  putAsset: async (a: StockAsset) => void assets.set(a.id, a),
  getStockStatus: async (id: string) => ({ lastSuccessAt: null, lastError: null, ...(statuses.get(id) ?? { historyLoadedAt: null, eodDoneFor: null, consecutiveFailures: 0 }) }),
  putStockStatus: async (id: string, s: { historyLoadedAt: string | null; eodDoneFor: string | null; consecutiveFailures: number }) => void statuses.set(id, s),
  putQuote: async () => undefined,
  putDailyCandles: async () => undefined,
  putIntradayCandles: async () => undefined,
}));
vi.mock('../src/stock', async (original) => ({
  ...(await original<typeof import('../src/stock')>()),
  stockProvider: (source: StockSource) => ({
    source,
    lookup: async (symbol: string) => {
      const id = `${source}:${symbol}`;
      fetched.push({ kind: 'lookup', asset: id });
      return { ...(symbol === 'BTC-USD' ? { ...btc, firstTradeDate: null } : idx), id, source };
    },
    daily: async (a: StockAsset, from: Date) => (fetched.push({ kind: 'daily', asset: a.id, daysBack: daysBack(from) }), snapshot(10)),
    intraday: async (a: StockAsset, from: Date) => {
      fetched.push({ kind: 'intraday', asset: a.id, daysBack: daysBack(from) });
      if (state.intradayFails) throw new Error('no 15m data');
      return snapshot(5);
    },
    quote: async (a: StockAsset) => (fetched.push({ kind: 'quote', asset: a.id }), null),
  }),
}));

const { handler } = await import('../src/handlers/stock-ingest');

/** Assets already loaded with their end-of-day passes done up to the given dates. */
function loaded(eodDone: Record<string, string>) {
  for (const a of [idx, btc, eodhdIdx]) {
    if (!eodDone[a.id]) continue;
    assets.set(a.id, a);
    statuses.set(a.id, { historyLoadedAt: '2026-10-01T00:00:00Z', eodDoneFor: eodDone[a.id]!, consecutiveFailures: 0 });
  }
}

describe('stock refresh tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetched.length = 0;
    checks.length = 0;
    assets.clear();
    statuses.clear();
    state.intradayFails = false;
    for (const id of Object.keys(profileAssets)) delete profileAssets[id];
    profileAssets.p1 = ['yahoo:ACME.JK'];
    profileAssets.p2 = ['yahoo:ACME.JK', 'yahoo:BTC-USD'];
  });
  afterEach(() => vi.useRealTimers());

  it("fetches the last two days of intraday bars while each asset's market is open, once per asset", async () => {
    vi.setSystemTime(new Date('2026-10-21T05:00:00Z')); // Wednesday, 12:00 in Jakarta
    loaded({ 'yahoo:ACME.JK': '2026-10-20', 'yahoo:BTC-USD': '2026-10-20' });
    expect(await handler({ mode: 'tick' })).toEqual({ refreshed: ['yahoo:ACME.JK', 'yahoo:BTC-USD'] });
    expect(fetched).toEqual([
      { kind: 'intraday', asset: 'yahoo:ACME.JK', daysBack: 2 },
      { kind: 'intraday', asset: 'yahoo:BTC-USD', daysBack: 2 },
    ]);
    // Each account tracking an asset gets its own volume check.
    expect(checks).toEqual([
      { kind: 'intraday', profileId: 'p1', asset: 'yahoo:ACME.JK' },
      { kind: 'intraday', profileId: 'p2', asset: 'yahoo:ACME.JK' },
      { kind: 'intraday', profileId: 'p2', asset: 'yahoo:BTC-USD' },
    ]);
  });

  it('runs the end-of-day refresh once after the close: two weeks of daily bars and a week of intraday bars', async () => {
    vi.setSystemTime(new Date('2026-10-21T10:30:00Z')); // 17:30 in Jakarta
    loaded({ 'yahoo:ACME.JK': '2026-10-20', 'yahoo:BTC-USD': '2026-10-20' });
    await handler({ mode: 'tick' });
    expect(fetched.filter((f) => f.asset === 'yahoo:ACME.JK')).toEqual([
      { kind: 'daily', asset: 'yahoo:ACME.JK', daysBack: 15 },
      { kind: 'intraday', asset: 'yahoo:ACME.JK', daysBack: 7 },
    ]);
    expect(statuses.get('yahoo:ACME.JK')?.eodDoneFor).toBe('2026-10-21');
    fetched.length = 0;
    await handler({ mode: 'tick' });
    expect(fetched.filter((f) => f.asset === 'yahoo:ACME.JK')).toEqual([]);
  });

  it('follows a source whose intraday bars arrive after the close by its quote, and fetches the bars once settled', async () => {
    profileAssets.p1 = ['eodhd:ACME.JK'];
    profileAssets.p2 = [];
    loaded({ 'eodhd:ACME.JK': '2026-10-20' });
    vi.setSystemTime(new Date('2026-10-21T05:00:00Z')); // 12:00 in Jakarta
    await handler({ mode: 'tick' });
    expect(fetched).toEqual([{ kind: 'quote', asset: 'eodhd:ACME.JK' }]);
    expect(checks).toEqual([{ kind: 'intraday', profileId: 'p1', asset: 'eodhd:ACME.JK' }]);

    fetched.length = 0;
    vi.setSystemTime(new Date('2026-10-21T10:30:00Z')); // 17:30: Yahoo's bars would be final, EODHD's not yet
    await handler({ mode: 'tick' });
    expect(fetched).toEqual([]);

    vi.setSystemTime(new Date('2026-10-21T12:15:00Z')); // 19:15
    await handler({ mode: 'tick' });
    expect(fetched).toEqual([
      { kind: 'daily', asset: 'eodhd:ACME.JK', daysBack: 15 },
      { kind: 'intraday', asset: 'eodhd:ACME.JK', daysBack: 7 },
    ]);
  });

  it('loads the full history (and asks for metadata) the first time it sees an asset', async () => {
    vi.setSystemTime(new Date('2026-10-24T05:00:00Z')); // Saturday
    await handler({ mode: 'tick' });
    const acme = fetched.filter((f) => f.asset === 'yahoo:ACME.JK');
    expect(acme[0]).toEqual({ kind: 'lookup', asset: 'yahoo:ACME.JK' });
    expect(acme[1]).toMatchObject({ kind: 'daily' });
    expect(acme[1]!.daysBack).toBeGreaterThan(3600); // since the first trade in 2016
    expect(acme[2]).toEqual({ kind: 'intraday', asset: 'yahoo:ACME.JK', daysBack: 10 });
    // Friday's session is in that history, so no end-of-day pass is due right after.
    expect(statuses.get('yahoo:ACME.JK')).toMatchObject({ eodDoneFor: '2026-10-23', historyLoadedAt: '2026-10-24T05:00:00.000Z' });
  });

  it('a failing intraday refill does not fail the daily refresh', async () => {
    vi.setSystemTime(new Date('2026-10-21T10:30:00Z'));
    loaded({ 'yahoo:ACME.JK': '2026-10-20', 'yahoo:BTC-USD': '2026-10-20' });
    state.intradayFails = true;
    await handler({ mode: 'tick' });
    expect(statuses.get('yahoo:ACME.JK')).toMatchObject({ eodDoneFor: '2026-10-21', consecutiveFailures: 0 });
  });

  it('resyncs one asset on request', async () => {
    vi.setSystemTime(new Date('2026-10-21T05:00:00Z'));
    loaded({ 'yahoo:ACME.JK': '2026-10-20', 'yahoo:BTC-USD': '2026-10-20' });
    expect(await handler({ mode: 'resync', asset: 'yahoo:BTC-USD' })).toEqual({ refreshed: ['yahoo:BTC-USD'] });
    expect(fetched.map((f) => f.kind)).toEqual(['lookup', 'daily', 'intraday']);
  });
});
