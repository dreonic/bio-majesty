import { ProfileIdSchema } from '@bio-majesty/shared';
import { describe, expect, it } from 'vitest';
import {
  groupByAccount,
  migratedProfileId,
  profileItems,
  profileName,
  profileObjectKey,
  profileRecords,
  profileVectorKey,
  type Item,
} from '../src/migrate/profiles';

const SUB = '79ca054c-c071-70ab-187f-06c2506dbc59';
const items: Item[] = [
  { PK: `USER#${SUB}`, SK: 'ART#a1', GSI1PK: `USER#${SUB}#STATUS#APPROVED`, GSI1SK: '2026-10-20#a1', id: 'a1', status: 'APPROVED' },
  { PK: `USER#${SUB}`, SK: 'ALIAS#url#abc', articleId: 'a1' },
  {
    PK: `USER#${SUB}`,
    SK: 'SETTINGS',
    data: { profile: { subject: 'Acme Group', context: 'A fictional group.', sentimentAsset: 'yahoo:ACME.JK' }, schedule: { enabled: true, dailyTime: '06:00' } },
  },
  {
    PK: `USER#${SUB}`,
    SK: 'CATEGORY#c1',
    search: { enabled: true, queries: [{ q: 'acme', edition: 'ID:id', lang: 'id' }, { q: 'acme labs', lang: 'en' }], exclude: [] },
    backfill: { status: 'done', months: 6, period: { amount: 6, unit: 'months' } },
  },
  { PK: `USER#${SUB}`, SK: 'CATEGORY#c2', search: { queries: [] }, backfill: { status: 'none', months: 3 } },
  { PK: `USER#${SUB}`, SK: 'TELEGRAM', chatId: 1 },
  { PK: `USER#${SUB}`, SK: 'TELEGRAM#256896516_0', chatId: 256896516 },
  { PK: 'USER#other', SK: 'SETTINGS', data: {} },
  { PK: 'STOCK#yahoo:ACME.JK', SK: 'QUOTE' },
];

describe('accounts become profiles', () => {
  it("gives each account's profile a stable ID in the profile ID format", () => {
    expect(migratedProfileId(SUB)).toBe(migratedProfileId(SUB));
    expect(migratedProfileId(SUB)).not.toBe(migratedProfileId('other'));
    expect(ProfileIdSchema.safeParse(migratedProfileId(SUB)).success).toBe(true);
  });

  it('finds the accounts of the old layout and names each profile after its subject', () => {
    const accounts = groupByAccount(items);
    expect([...accounts.keys()]).toEqual([SUB, 'other']);
    expect(profileName(accounts.get(SUB)!)).toBe('Acme Group');
    expect(profileName(accounts.get('other')!)).toBe('My news');
    expect(profileRecords(SUB, 'p1', 'Acme Group', '2026-10-30T00:00:00.000Z')).toEqual([
      { PK: `ACCOUNT#${SUB}`, SK: 'PROFILE#p1', id: 'p1', name: 'Acme Group', createdAt: '2026-10-30T00:00:00.000Z' },
      { PK: 'PROFILE#p1', SK: 'PROFILE', id: 'p1', name: 'Acme Group', createdAt: '2026-10-30T00:00:00.000Z', owner: SUB },
    ]);
  });

  it("moves the account's items to the profile, with the subject rename and the earlier migrations' cleanups", () => {
    const moved = profileItems(items, SUB, 'p1');
    expect(moved.every((i) => i.PK === 'PROFILE#p1')).toBe(true);
    expect(moved.map((i) => i.SK)).toEqual(['ART#a1', 'ALIAS#url#abc', 'SETTINGS', 'CATEGORY#c1', 'CATEGORY#c2', 'TELEGRAM#256896516_0']);
    expect(moved[0]).toMatchObject({ GSI1PK: 'PROFILE#p1#STATUS#APPROVED', GSI1SK: '2026-10-20#a1' });
    expect(moved[2]!.data).toEqual({
      subject: { name: 'Acme Group', context: 'A fictional group.', sentimentAsset: 'yahoo:ACME.JK' },
      schedule: { enabled: true, dailyTime: '06:00' },
    });
    expect(moved[3]).toMatchObject({
      search: { enabled: true, queries: [{ q: 'acme', edition: 'ID:id' }, { q: 'acme labs', edition: 'ID:en' }], exclude: [] },
      backfill: { status: 'done', period: { amount: 6, unit: 'months' } },
    });
    expect(moved[3]!.backfill).not.toHaveProperty('months');
    expect(moved[4]!.backfill).toEqual({ status: 'none', period: { amount: 3, unit: 'months' } });
    // The input is left as it was (the old layout stays until --cleanup).
    expect(items[2]!.data).toHaveProperty('profile');
  });

  it("maps the account's objects and vectors to the profile's", () => {
    expect(profileObjectKey(`users/${SUB}/articles/a1.json`, SUB, 'p1')).toBe('profiles/p1/articles/a1.json');
    expect(profileObjectKey(`chats/${SUB}/c1.json`, SUB, 'p1')).toBe('profiles/p1/chats/c1.json');
    expect(profileObjectKey('users/other/articles/a1.json', SUB, 'p1')).toBeNull();
    expect(profileObjectKey('raw/run1/t1.json', SUB, 'p1')).toBeNull();
    expect(profileVectorKey(`${SUB}#a1#0`, SUB, 'p1')).toBe('p1#a1#0');
    expect(profileVectorKey('other#a1#0', SUB, 'p1')).toBeNull();
  });
});
