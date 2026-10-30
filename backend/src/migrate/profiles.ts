/**
 * Accounts become profiles: everything an account owned (partition `USER#<sub>`) becomes its first
 * profile's (`PROFILE#<id>`), used by scripts/migrate-profiles.ts. Pure: no AWS calls.
 */
import { hashId } from '../lib/ids';

export type Item = Record<string, unknown>;

/** The migrated profile's ID: derived from the account, so a repeated run finds the same profile. */
export const migratedProfileId = (sub: string) => hashId(`profile:${sub}`, 12);

/** Queries saved before editions named only a language (all searched Google News Indonesia). */
const LEGACY_EDITIONS: Record<string, string> = { id: 'ID:id', en: 'ID:en' };

/** The old layout's items by account (Cognito sub). */
export function groupByAccount(items: Item[]): Map<string, Item[]> {
  const byAccount = new Map<string, Item[]>();
  for (const item of items) {
    const pk = String(item.PK ?? '');
    if (!pk.startsWith('USER#')) continue;
    const sub = pk.slice('USER#'.length);
    byAccount.set(sub, [...(byAccount.get(sub) ?? []), item]);
  }
  return byAccount;
}

/** The profile's name: the subject the account follows, if it named one. */
export function profileName(items: Item[]): string {
  const settings = items.find((i) => i.SK === 'SETTINGS')?.data as { profile?: { subject?: unknown } } | undefined;
  const subject = typeof settings?.profile?.subject === 'string' ? settings.profile.subject.trim() : '';
  return subject.slice(0, 60) || 'My news';
}

/** The profile's records: its entry in the account's list, and its own record. */
export function profileRecords(sub: string, profileId: string, name: string, createdAt: string): Item[] {
  const profile = { id: profileId, name, createdAt };
  return [
    { PK: `ACCOUNT#${sub}`, SK: `PROFILE#${profileId}`, ...profile },
    { PK: `PROFILE#${profileId}`, SK: 'PROFILE', ...profile, owner: sub },
  ];
}

/**
 * One account's items in its profile's partition: keys and GSI1 keys moved, the settings' `profile`
 * block renamed `subject` (its `subject` field `name`), and what earlier migrations left for their
 * cleanups dropped: the single `TELEGRAM` link item, queries' `lang` and backfills' `months`.
 */
export function profileItems(items: Item[], sub: string, profileId: string): Item[] {
  const from = `USER#${sub}`;
  const to = `PROFILE#${profileId}`;
  return items
    .filter((item) => item.PK === from && item.SK !== 'TELEGRAM')
    .map((item) => {
      const next: Item = { ...item, PK: to };
      if (typeof item.GSI1PK === 'string' && item.GSI1PK.startsWith(`${from}#`)) next.GSI1PK = `${to}${item.GSI1PK.slice(from.length)}`;
      if (item.SK === 'SETTINGS') next.data = settingsData(item.data);
      if (String(item.SK).startsWith('CATEGORY#')) Object.assign(next, categoryFields(item));
      return next;
    });
}

function settingsData(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('profile' in data)) return data;
  const { profile, ...rest } = data as Item & { profile?: { subject?: unknown; context?: unknown; sentimentAsset?: unknown } };
  return {
    ...rest,
    subject: { name: profile?.subject ?? '', context: profile?.context ?? '', sentimentAsset: profile?.sentimentAsset ?? null },
  };
}

function categoryFields(item: Item): Item {
  const search = (item.search ?? {}) as Item & { queries?: Item[] };
  const backfill = (item.backfill ?? {}) as Item;
  const queries = (search.queries ?? []).map(({ lang, ...q }) => ({ ...q, edition: q.edition ?? LEGACY_EDITIONS[String(lang)] ?? 'ID:id' }));
  const { months, ...rest } = backfill;
  const period = 'period' in backfill ? backfill.period : Number(months ?? 0) > 0 ? { amount: Number(months), unit: 'months' } : null;
  return { search: { ...search, queries }, backfill: { ...rest, period } };
}

/** An old object key (article text, chat history) as the profile's, or null if it isn't the account's. */
export function profileObjectKey(key: string, sub: string, profileId: string): string | null {
  const articles = `users/${sub}/articles/`;
  const chats = `chats/${sub}/`;
  if (key.startsWith(articles)) return `profiles/${profileId}/articles/${key.slice(articles.length)}`;
  if (key.startsWith(chats)) return `profiles/${profileId}/chats/${key.slice(chats.length)}`;
  return null;
}

/** An old vector key ("<sub>#<articleId>#<chunk>") as the profile's, or null if it isn't the account's. */
export function profileVectorKey(key: string, sub: string, profileId: string): string | null {
  return key.startsWith(`${sub}#`) ? `${profileId}${key.slice(sub.length)}` : null;
}
