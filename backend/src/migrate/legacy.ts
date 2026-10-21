import { DEFAULT_PROFILE, DEFAULT_SETTINGS, quarterHour, type ArticleStatus, type Settings } from '@bio-majesty/shared';
import { aliasIdsOf } from '../repo/articles';
import { stripKeys } from '../repo/client';
import { accountPk, keys } from '../repo/keys';
import { mergeSettings } from '../repo/settings';

/**
 * The single shared desk stored before accounts existed, and how it maps into one account
 * (used once by scripts/migrate-to-accounts.ts). Pure: no AWS calls.
 */

export type Item = Record<string, unknown>;

const pk = (i: Item) => String(i.PK);
const sk = (i: Item) => String(i.SK);

/** The items of the shared desk, by kind. */
export function legacyItems(items: Item[]) {
  return {
    articles: items.filter((i) => pk(i).startsWith('ART#') && sk(i) === 'META'),
    aliases: items.filter((i) => pk(i).startsWith('ALIAS#') && sk(i) === 'ALIAS'),
    categories: items.filter((i) => pk(i) === 'CATEGORY'),
    settings: items.find((i) => pk(i) === 'SETTINGS' && sk(i) === 'GLOBAL'),
    telegram: items.find((i) => pk(i) === 'SETTINGS' && sk(i) === 'TELEGRAM'),
    runs: items.filter((i) => pk(i) === 'RUN'),
    digests: items.filter((i) => pk(i) === 'DIGEST'),
    feedback: items.filter((i) => pk(i) === 'FEEDBACK'),
    anomalies: items.filter((i) => pk(i).startsWith('STOCK#') && sk(i).startsWith('ANOMALY#')),
    intraday: items.filter((i) => pk(i).startsWith('STOCK#') && sk(i).startsWith('I#')),
  };
}
export type LegacyItems = ReturnType<typeof legacyItems>;

/** Old settings (one stock symbol) as an account's settings (a symbol list and a profile). */
export function migratedSettings(data: Item | undefined): Settings {
  const old = (data ?? {}) as Partial<Settings> & { stock?: Partial<Settings['stock']> & { symbol?: string } };
  const { symbol = 'PRDA.JK', ...stock } = old.stock ?? {};
  return mergeSettings(DEFAULT_SETTINGS, {
    ...old,
    ...(old.schedule && { schedule: { ...old.schedule, dailyTime: quarterHour(old.schedule.dailyTime) } }),
    stock: { ...DEFAULT_SETTINGS.stock, ...stock, symbols: [symbol] },
    profile: { ...DEFAULT_PROFILE, sentimentSymbol: symbol },
  });
}

/** Every item the account gets: copies keyed by `USER#<sub>`, the bot offset kept apart. */
export function accountItems(sub: string, old: LegacyItems): Item[] {
  const aliasIds = new Map<string, string[]>();
  for (const a of old.aliases) {
    const articleId = String(a.articleId);
    aliasIds.set(articleId, [...(aliasIds.get(articleId) ?? []), pk(a).replace(/^ALIAS#/, '')]);
  }
  const out: Item[] = [];
  for (const a of old.articles) {
    const id = pk(a).replace(/^ART#/, '');
    // The filtered articles' expiry (expiresAt) carries over.
    const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, ...article } = a;
    const ids = aliasIds.get(id) ?? aliasIdsOf(a);
    out.push({
      ...article,
      ...keys.article(sub, id),
      ...keys.articleGsi(sub, article.status as ArticleStatus, String(article.publishedAt), id),
      ...(ids.length ? { aliasIds: new Set(ids) } : {}),
    });
  }
  for (const a of old.aliases) out.push({ ...keys.alias(sub, pk(a).replace(/^ALIAS#/, '')), articleId: a.articleId });
  for (const c of old.categories) out.push({ ...stripKeys(c), ...keys.category(sub, sk(c)) });
  for (const r of old.runs) out.push({ ...stripKeys(r), ...keys.run(sub, sk(r)) });
  for (const d of old.digests) out.push({ ...stripKeys(d), PK: accountPk(sub), SK: `DIGEST#${sk(d)}` });
  for (const f of old.feedback) out.push({ ...stripKeys(f), PK: accountPk(sub), SK: `FEEDBACK#${sk(f)}` });
  for (const x of old.anomalies) {
    out.push({ ...stripKeys(x), ...keys.anomaly(sub, pk(x).replace(/^STOCK#/, ''), sk(x).replace(/^ANOMALY#/, '')) });
  }
  out.push({ ...keys.settings(sub), data: migratedSettings(old.settings?.data as Item | undefined) });
  if (old.telegram) {
    const { chatId = null, chatTitle = null, linkedAt = null, updateOffset = 0 } = old.telegram;
    out.push({ ...keys.telegram(sub), chatId, chatTitle, linkedAt });
    out.push({ ...keys.telegramBot(), updateOffset });
  }
  return out;
}
