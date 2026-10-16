import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Record<string, unknown>[] = [];

// yahoo-finance2 validates options and rejects `period2: undefined`; record what the provider passes.
vi.mock('yahoo-finance2', () => ({
  default: class {
    async chart(_symbol: string, options: Record<string, unknown>) {
      calls.push(options);
      return { quotes: [], meta: {} };
    }
  },
}));

const { YahooStockProvider } = await import('../src/stock/yahoo');

describe('Yahoo provider', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('leaves period2 out when no end date is given (the full-history load)', async () => {
    await new YahooStockProvider().daily('PRDA.JK', new Date('2016-12-01T00:00:00Z'));
    expect(calls[0]).not.toHaveProperty('period2');
    expect(calls[0]).toMatchObject({ interval: '1d', return: 'array' });
  });

  it('passes period2 when an end date is given', async () => {
    const to = new Date('2026-10-16T00:00:00Z');
    await new YahooStockProvider().daily('PRDA.JK', new Date('2026-10-01T00:00:00Z'), to);
    expect(calls[0]).toMatchObject({ period2: to });
  });

  it('asks for 15-minute bars without an end date', async () => {
    await new YahooStockProvider().intraday('PRDA.JK', new Date('2026-10-14T00:00:00Z'));
    expect(calls[0]).not.toHaveProperty('period2');
    expect(calls[0]).toMatchObject({ interval: '15m' });
  });
});
