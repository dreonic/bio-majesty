import type { ArticleStatus } from '@bio-majesty/shared';
import type { AliasKey } from '../lib/url';

/** Single-table key layout (see docs/architecture.md). */
export const keys = {
  article: (id: string) => ({ PK: `ART#${id}`, SK: 'META' }),
  articleGsi: (status: ArticleStatus, publishedAt: string, id: string) => ({
    GSI1PK: `STATUS#${status}`,
    GSI1SK: `${publishedAt}#${id}`,
  }),
  alias: (alias: AliasKey) => ({ PK: `ALIAS#${alias.kind}#${alias.hash}`, SK: 'ALIAS' }),
  runItem: (runId: string, articleId: string) => ({ PK: `RUNITEM#${runId}`, SK: articleId }),
  category: (id: string) => ({ PK: 'CATEGORY', SK: id }),
  run: (runId: string) => ({ PK: 'RUN', SK: runId }),
  digest: (createdAt: string, id: string) => ({ PK: 'DIGEST', SK: `${createdAt}#${id}` }),
  stockDaily: (symbol: string, ymd: string) => ({ PK: `STOCK#${symbol}`, SK: `D#${ymd}` }),
  stockIntraday: (symbol: string, epoch: number) => ({ PK: `STOCK#${symbol}`, SK: `I#${String(epoch).padStart(10, '0')}` }),
  stockQuote: (symbol: string) => ({ PK: `STOCK#${symbol}`, SK: 'QUOTE' }),
  stockStatus: (symbol: string) => ({ PK: `STOCK#${symbol}`, SK: 'STATUS' }),
  stockAnomaly: (symbol: string, ymd: string) => ({ PK: `STOCK#${symbol}`, SK: `ANOMALY#${ymd}` }),
  settings: () => ({ PK: 'SETTINGS', SK: 'GLOBAL' }),
  telegram: () => ({ PK: 'SETTINGS', SK: 'TELEGRAM' }),
  telegramLink: (code: string) => ({ PK: `TGLINK#${code}`, SK: 'TGLINK' }),
  conversation: (sub: string, id: string) => ({ PK: `USER#${sub}`, SK: `CHAT#${id}` }),
};
