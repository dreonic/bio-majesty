import type { Article, ArticleStatus, Suggestion } from '@bio-majesty/shared';
import { articleIdForUrl, isGoogleNewsUrl } from '../lib/url';
import { hashId } from '../lib/ids';
import type { MergedCandidate } from '../sources/types';

/** Build an Article record from a merged search candidate. */
export function articleFromCandidate(
  c: MergedCandidate,
  opts: {
    status: ArticleStatus;
    runId: string;
    runType: 'daily' | 'backfill';
    categoryId: string | null;
    url?: string;
    suggestion?: Suggestion | null;
    filterReason?: string | null;
    textStatus?: Article['textStatus'];
    snippet?: string | null;
    lang?: string | null;
    publishedAt?: string | null;
  },
): Article {
  const url = opts.url ?? c.url;
  const id = isGoogleNewsUrl(url) && c.gnewsId ? hashId(`gnews:${c.gnewsId}`) : articleIdForUrl(url);
  const now = new Date().toISOString();
  return {
    id,
    url,
    sourceUrl: url !== c.url ? c.url : null,
    title: c.title,
    sourceName: c.sourceName,
    sourceDomain: c.sourceDomain,
    publishedAt: opts.publishedAt ?? c.publishedAt ?? now,
    lang: opts.lang ?? c.lang,
    snippet: opts.snippet ?? c.snippet,
    textStatus: opts.textStatus ?? 'skipped',
    status: opts.status,
    suggestion: opts.suggestion ?? null,
    final: null,
    filterReason: opts.filterReason ?? null,
    origin: { type: opts.runType, runId: opts.runId, categoryId: opts.categoryId ?? c.categoryHints[0] ?? null },
    foundBy: c.foundBy.slice(0, 10),
    createdAt: now,
    reviewedAt: null,
    indexedAt: null,
  };
}
