import { describe, expect, it } from 'vitest';
import { accountItems, legacyItems, migratedSettings } from '../src/migrate/legacy';

/** A small shared desk as stored before accounts existed. */
const legacy = [
  { PK: 'ART#a1', SK: 'META', GSI1PK: 'STATUS#APPROVED', GSI1SK: '2026-10-13T00:00:00Z#a1', id: 'a1', status: 'APPROVED', publishedAt: '2026-10-13T00:00:00Z', title: 'Laba naik', url: 'https://kontan.co.id/a1' },
  { PK: 'ART#f1', SK: 'META', GSI1PK: 'STATUS#FILTERED', GSI1SK: '2026-10-14T00:00:00Z#f1', id: 'f1', status: 'FILTERED', publishedAt: '2026-10-14T00:00:00Z', title: 'Prodia AI image API', url: 'https://example.com/f1', expiresAt: 1_800_000_000 },
  { PK: 'ALIAS#url#h1', SK: 'ALIAS', articleId: 'a1' },
  { PK: 'ALIAS#title#h2', SK: 'ALIAS', articleId: 'a1' },
  { PK: 'CATEGORY', SK: 'c1', id: 'c1', name: 'Prodia Widyahusada' },
  { PK: 'SETTINGS', SK: 'GLOBAL', data: { schedule: { enabled: true, dailyTime: '06:10' }, stock: { symbol: 'PRDA.JK', volumeAlerts: false, volumeRatio: 3 } } },
  { PK: 'SETTINGS', SK: 'TELEGRAM', chatId: 101, chatTitle: 'Exec', linkedAt: '2026-10-10T00:00:00Z', updateOffset: 42 },
  { PK: 'RUN', SK: '20261020230000-abc', id: '20261020230000-abc', status: 'succeeded' },
  { PK: 'DIGEST', SK: '2026-10-21T00:00:00Z#2026-10-21', id: '2026-10-21' },
  { PK: 'FEEDBACK', SK: '2026-10-20T01:00:00Z#a1', articleId: 'a1', decision: 'approved' },
  { PK: 'STOCK#PRDA.JK', SK: 'ANOMALY#2026-10-15', date: '2026-10-15', notifiedAt: '2026-10-15T09:00:00Z' },
  { PK: 'STOCK#PRDA.JK', SK: 'I#1790000000', time: 1_790_000_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  { PK: 'STOCK#PRDA.JK', SK: 'D#2026-10-15', time: 1_792_022_400 },
  { PK: 'RUNITEM#r1', SK: 'a1' },
];

describe('migration of the shared desk into an account', () => {
  const old = legacyItems(legacy);
  const items = accountItems('u1', old);
  const find = (sk: string) => items.find((i) => i.SK === sk);

  it('picks out the shared items (market data and run scratch stay where they are)', () => {
    expect(old.articles).toHaveLength(2);
    expect(old.aliases).toHaveLength(2);
    expect(old.intraday).toHaveLength(1);
    expect(items.every((i) => i.PK === 'USER#u1' || i.PK === 'TELEGRAM')).toBe(true);
  });

  it("copies articles with the account's keys and their dedupe keys", () => {
    expect(find('ART#a1')).toMatchObject({
      PK: 'USER#u1',
      GSI1PK: 'USER#u1#STATUS#APPROVED',
      GSI1SK: '2026-10-13T00:00:00Z#a1',
      status: 'APPROVED',
      aliasIds: new Set(['url#h1', 'title#h2']),
    });
    expect(find('ALIAS#url#h1')).toEqual({ PK: 'USER#u1', SK: 'ALIAS#url#h1', articleId: 'a1' });
    // Filtered articles keep their 30-day expiry; one without stored keys gets them computed.
    expect(find('ART#f1')).toMatchObject({ expiresAt: 1_800_000_000 });
    expect((find('ART#f1')?.aliasIds as Set<string>).size).toBeGreaterThan(0);
  });

  it('turns the settings into an account profile with a list of assets', () => {
    const data = find('SETTINGS')?.data as ReturnType<typeof migratedSettings>;
    expect(data.stock).toEqual({ symbols: ['PRDA.JK'], volumeAlerts: false, volumeRatio: 3 });
    expect(data.profile.sentimentSymbol).toBe('PRDA.JK');
    expect(data.schedule.dailyTime).toBe('06:00');
    expect(migratedSettings(undefined).stock.symbols).toEqual(['PRDA.JK']);
  });

  it('keeps the Telegram link for the account and the update offset for the bot', () => {
    expect(find('TELEGRAM')).toEqual({ PK: 'USER#u1', SK: 'TELEGRAM', chatId: 101, chatTitle: 'Exec', linkedAt: '2026-10-10T00:00:00Z' });
    expect(items.find((i) => i.PK === 'TELEGRAM')).toEqual({ PK: 'TELEGRAM', SK: 'BOT', updateOffset: 42 });
  });

  it('moves categories, runs, digests, feedback and volume alerts', () => {
    expect(find('CATEGORY#c1')).toMatchObject({ name: 'Prodia Widyahusada' });
    expect(find('RUN#20261020230000-abc')).toMatchObject({ status: 'succeeded' });
    expect(find('DIGEST#2026-10-21T00:00:00Z#2026-10-21')).toMatchObject({ id: '2026-10-21' });
    expect(find('FEEDBACK#2026-10-20T01:00:00Z#a1')).toMatchObject({ decision: 'approved' });
    expect(find('ANOMALY#PRDA.JK#2026-10-15')).toMatchObject({ notifiedAt: '2026-10-15T09:00:00Z' });
  });
});
