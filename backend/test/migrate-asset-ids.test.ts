import { describe, expect, it } from 'vitest';
import { planAssetIdMigration } from '../src/migrate/asset-ids';

/** A table as stored before assets had a source. */
const before = [
  { PK: 'STOCK#PRDA.JK', SK: 'META', symbol: 'PRDA.JK', name: 'PT Prodia Widyahusada Tbk', timeZone: 'Asia/Jakarta' },
  { PK: 'STOCK#PRDA.JK', SK: 'QUOTE', symbol: 'PRDA.JK', provider: 'yahoo', price: 2900, previousClose: 2850 },
  { PK: 'STOCK#PRDA.JK', SK: 'STATUS', historyLoadedAt: '2026-10-16T05:00:00Z', eodDoneFor: '2026-10-21', consecutiveFailures: 0 },
  { PK: 'STOCK#PRDA.JK', SK: 'D#2026-10-21', time: 1_792_540_800, open: 2880, high: 2910, low: 2870, close: 2900, volume: 120_000 },
  { PK: 'STOCK#PRDA.JK', SK: 'I#1792548000', time: 1_792_548_000, open: 2880, high: 2890, low: 2870, close: 2885, volume: 1000, expiresAt: 1_793_412_000 },
  { PK: 'STOCK#^JKSE', SK: 'META', symbol: '^JKSE', name: 'IDX Composite' },
  { PK: 'USER#u1', SK: 'SETTINGS', data: { stock: { symbols: ['PRDA.JK', '^JKSE'], volumeAlerts: true, volumeRatio: 3 }, profile: { subject: 'the Prodia group', sentimentSymbol: 'PRDA.JK' } } },
  { PK: 'USER#u2', SK: 'SETTINGS', data: { profile: { subject: 'Acme', sentimentSymbol: null } } },
  { PK: 'USER#u3', SK: 'SETTINGS', data: { schedule: { enabled: true, dailyTime: '06:00' } } },
  { PK: 'USER#u1', SK: 'ANOMALY#PRDA.JK#2026-10-15', date: '2026-10-15', ratio: 3.1, notifiedAt: '2026-10-15T09:00:00Z' },
  { PK: 'USER#u1', SK: 'ART#a1', title: 'Not touched' },
];

describe('migration to asset IDs', () => {
  const plan = planAssetIdMigration(before);
  const put = (PK: string, SK: string) => plan.puts.find((i) => i.PK === PK && i.SK === SK);

  it('copies each market-data partition under the asset ID, naming the asset in its metadata and quote', () => {
    expect(plan.ids).toEqual(new Map([['PRDA.JK', 'yahoo:PRDA.JK'], ['^JKSE', 'yahoo:^JKSE']]));
    expect(put('STOCK#yahoo:PRDA.JK', 'META')).toMatchObject({ id: 'yahoo:PRDA.JK', source: 'yahoo', symbol: 'PRDA.JK', name: 'PT Prodia Widyahusada Tbk' });
    const quote = put('STOCK#yahoo:PRDA.JK', 'QUOTE')!;
    expect(quote).toMatchObject({ asset: 'yahoo:PRDA.JK', price: 2900 });
    expect(quote).not.toHaveProperty('symbol');
    expect(quote).not.toHaveProperty('provider');
    // Status, daily bars and 15-minute bars (with their expiry) as they are.
    expect(put('STOCK#yahoo:PRDA.JK', 'STATUS')).toMatchObject({ eodDoneFor: '2026-10-21' });
    expect(put('STOCK#yahoo:PRDA.JK', 'D#2026-10-21')).toMatchObject({ close: 2900 });
    expect(put('STOCK#yahoo:PRDA.JK', 'I#1792548000')).toMatchObject({ expiresAt: 1_793_412_000 });
    expect(plan.counts).toEqual({ marketData: 6, settings: 2, anomalies: 1 });
  });

  it("renames the accounts' assets and sentiment asset, and moves their volume alerts", () => {
    expect(put('USER#u1', 'SETTINGS')).toEqual({
      PK: 'USER#u1',
      SK: 'SETTINGS',
      data: { stock: { assets: ['yahoo:PRDA.JK', 'yahoo:^JKSE'], volumeAlerts: true, volumeRatio: 3 }, profile: { subject: 'the Prodia group', sentimentAsset: 'yahoo:PRDA.JK' } },
    });
    expect(put('USER#u2', 'SETTINGS')).toEqual({ PK: 'USER#u2', SK: 'SETTINGS', data: { profile: { subject: 'Acme', sentimentAsset: null } } });
    // Nothing to rename (defaults apply): left alone.
    expect(put('USER#u3', 'SETTINGS')).toBeUndefined();
    expect(plan.replacedSettings.map((i) => i.PK)).toEqual(['USER#u1', 'USER#u2']);
    expect(put('USER#u1', 'ANOMALY#yahoo:PRDA.JK#2026-10-15')).toMatchObject({ ratio: 3.1, notifiedAt: '2026-10-15T09:00:00Z' });
    expect(plan.puts.some((i) => i.SK === 'ART#a1')).toBe(false);
  });

  it('takes each symbol from the source its quote came from', () => {
    const eodhd = planAssetIdMigration([{ PK: 'STOCK#AAPL.US', SK: 'QUOTE', symbol: 'AAPL.US', provider: 'eodhd', price: 230 }]);
    expect(eodhd.ids.get('AAPL.US')).toBe('eodhd:AAPL.US');
  });

  it('keeps what the new version already wrote, and lets the cleanup delete only old items with a copy', () => {
    expect(plan.oldKeys).toHaveLength(7);
    expect(plan.oldKeys.every((k) => !k.copied)).toBe(true);
    // After the migration ran (and the new version refreshed the quote), the cleanup's plan:
    const after = [...before, ...plan.puts.filter((i) => String(i.PK).startsWith('STOCK#') || String(i.SK).startsWith('ANOMALY#'))];
    after.push({ PK: 'STOCK#yahoo:PRDA.JK', SK: 'QUOTE', asset: 'yahoo:PRDA.JK', price: 2950 });
    const cleanup = planAssetIdMigration(after);
    expect(cleanup.oldKeys.filter((k) => k.copied)).toHaveLength(7);
    expect(cleanup.puts.some((i) => i.PK === 'STOCK#yahoo:PRDA.JK' && i.SK === 'QUOTE')).toBe(false);
  });
});
