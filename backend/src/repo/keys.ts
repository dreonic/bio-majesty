import type { ArticleStatus } from '@bio-majesty/shared';

/** Partition holding everything one account owns (its Cognito sub). */
export const accountPk = (sub: string) => `USER#${sub}`;

/**
 * Single-table key layout (see docs/architecture.md). Everything an account owns lives in its
 * partition `USER#<sub>`; market data is shared per asset (`STOCK#<asset ID>`, e.g. `STOCK#yahoo:D05.SI`).
 */
export const keys = {
  article: (sub: string, id: string) => ({ PK: accountPk(sub), SK: `ART#${id}` }),
  articleGsi: (sub: string, status: ArticleStatus, publishedAt: string, id: string) => ({
    GSI1PK: `${accountPk(sub)}#STATUS#${status}`,
    GSI1SK: `${publishedAt}#${id}`,
  }),
  /** `aliasId` is "<kind>#<hash>" (see aliasId in articles.ts). */
  alias: (sub: string, aliasId: string) => ({ PK: accountPk(sub), SK: `ALIAS#${aliasId}` }),
  runItem: (runId: string, articleId: string) => ({ PK: `RUNITEM#${runId}`, SK: articleId }),
  category: (sub: string, id: string) => ({ PK: accountPk(sub), SK: `CATEGORY#${id}` }),
  run: (sub: string, runId: string) => ({ PK: accountPk(sub), SK: `RUN#${runId}` }),
  digest: (sub: string, createdAt: string, id: string) => ({ PK: accountPk(sub), SK: `DIGEST#${createdAt}#${id}` }),
  feedback: (sub: string, decidedAt: string, articleId: string) => ({ PK: accountPk(sub), SK: `FEEDBACK#${decidedAt}#${articleId}` }),
  settings: (sub: string) => ({ PK: accountPk(sub), SK: 'SETTINGS' }),
  telegram: (sub: string) => ({ PK: accountPk(sub), SK: 'TELEGRAM' }),
  /** The bot's getUpdates offset (one bot for every account). */
  telegramBot: () => ({ PK: 'TELEGRAM', SK: 'BOT' }),
  telegramLink: (code: string) => ({ PK: `TGLINK#${code}`, SK: 'TGLINK' }),
  conversation: (sub: string, id: string) => ({ PK: accountPk(sub), SK: `CHAT#${id}` }),
  /** An account's volume alert for one asset and trading date. */
  anomaly: (sub: string, asset: string, ymd: string) => ({ PK: accountPk(sub), SK: `ANOMALY#${asset}#${ymd}` }),
  stockDaily: (asset: string, ymd: string) => ({ PK: `STOCK#${asset}`, SK: `D#${ymd}` }),
  stockIntraday: (asset: string, epoch: number) => ({ PK: `STOCK#${asset}`, SK: `I#${String(epoch).padStart(10, '0')}` }),
  stockQuote: (asset: string) => ({ PK: `STOCK#${asset}`, SK: 'QUOTE' }),
  stockStatus: (asset: string) => ({ PK: `STOCK#${asset}`, SK: 'STATUS' }),
  stockMeta: (asset: string) => ({ PK: `STOCK#${asset}`, SK: 'META' }),
};

