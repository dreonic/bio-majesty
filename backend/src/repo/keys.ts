import type { ArticleStatus } from '@bio-majesty/shared';

/**
 * One of an account's profiles. Everything a profile owns is keyed by it. Branded so a Cognito
 * sub can't be passed where a profile is meant: an ID becomes one only after it is checked
 * against the signed-in account, or when it comes from a run, a stream record or a profile list.
 */
export type ProfileId = string & { readonly __brand: 'ProfileId' };
export const asProfileId = (id: string) => id as ProfileId;

/** Partition holding everything one profile owns. */
export const profilePk = (profileId: ProfileId) => `PROFILE#${profileId}`;

/** Partition listing one account's profiles (the account's Cognito sub). */
export const accountPk = (sub: string) => `ACCOUNT#${sub}`;

/**
 * Single-table key layout (see docs/architecture.md). Everything a profile owns lives in its
 * partition `PROFILE#<id>`; an account's partition `ACCOUNT#<sub>` lists its profiles; market data
 * is shared per asset (`STOCK#<asset ID>`, e.g. `STOCK#yahoo:D05.SI`).
 */
export const keys = {
  /** One of the account's profiles (its name): the profile menu, and the check that a profile is the caller's. */
  accountProfile: (sub: string, profileId: ProfileId) => ({ PK: accountPk(sub), SK: `PROFILE#${profileId}` }),
  /** The profile's own record: its name and the account it belongs to, for jobs that only know the profile. */
  profile: (profileId: ProfileId) => ({ PK: profilePk(profileId), SK: 'PROFILE' }),
  article: (profileId: ProfileId, id: string) => ({ PK: profilePk(profileId), SK: `ART#${id}` }),
  articleGsi: (profileId: ProfileId, status: ArticleStatus, publishedAt: string, id: string) => ({
    GSI1PK: `${profilePk(profileId)}#STATUS#${status}`,
    GSI1SK: `${publishedAt}#${id}`,
  }),
  /** `aliasId` is "<kind>#<hash>" (see aliasId in articles.ts). */
  alias: (profileId: ProfileId, aliasId: string) => ({ PK: profilePk(profileId), SK: `ALIAS#${aliasId}` }),
  runItem: (runId: string, articleId: string) => ({ PK: `RUNITEM#${runId}`, SK: articleId }),
  category: (profileId: ProfileId, id: string) => ({ PK: profilePk(profileId), SK: `CATEGORY#${id}` }),
  run: (profileId: ProfileId, runId: string) => ({ PK: profilePk(profileId), SK: `RUN#${runId}` }),
  digest: (profileId: ProfileId, createdAt: string, id: string) => ({ PK: profilePk(profileId), SK: `DIGEST#${createdAt}#${id}` }),
  feedback: (profileId: ProfileId, decidedAt: string, articleId: string) => ({ PK: profilePk(profileId), SK: `FEEDBACK#${decidedAt}#${articleId}` }),
  settings: (profileId: ProfileId) => ({ PK: profilePk(profileId), SK: 'SETTINGS' }),
  /** One of the profile's Telegram connections (`id` from telegramLinkId). */
  telegramChat: (profileId: ProfileId, id: string) => ({ PK: profilePk(profileId), SK: `TELEGRAM#${id}` }),
  /** The bot's getUpdates offset (one bot for every profile). */
  telegramBot: () => ({ PK: 'TELEGRAM', SK: 'BOT' }),
  telegramLink: (code: string) => ({ PK: `TGLINK#${code}`, SK: 'TGLINK' }),
  conversation: (profileId: ProfileId, id: string) => ({ PK: profilePk(profileId), SK: `CHAT#${id}` }),
  /** A profile's volume alert for one asset and trading date. */
  anomaly: (profileId: ProfileId, asset: string, ymd: string) => ({ PK: profilePk(profileId), SK: `ANOMALY#${asset}#${ymd}` }),
  stockDaily: (asset: string, ymd: string) => ({ PK: `STOCK#${asset}`, SK: `D#${ymd}` }),
  stockIntraday: (asset: string, epoch: number) => ({ PK: `STOCK#${asset}`, SK: `I#${String(epoch).padStart(10, '0')}` }),
  stockQuote: (asset: string) => ({ PK: `STOCK#${asset}`, SK: 'QUOTE' }),
  stockStatus: (asset: string) => ({ PK: `STOCK#${asset}`, SK: 'STATUS' }),
  stockMeta: (asset: string) => ({ PK: `STOCK#${asset}`, SK: 'META' }),
};
