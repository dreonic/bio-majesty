import type { Edition } from '@bio-majesty/shared';

export type SourceProvider = 'gnews' | 'gdelt';

/** One unit of search work executed by the `search` pipeline step. */
export interface SearchTask {
  id: string;
  provider: SourceProvider;
  /** Null for the shared GDELT task, which covers queries from several categories. */
  categoryId: string | null;
  queries: { q: string; edition: Edition; categoryId: string; exclude: string[] }[];
  from: string;
  to: string;
  /** 'when' = relative (daily runs), 'range' = absolute dates (backfills). */
  mode: 'when' | 'range';
}

/** A search hit before de-duplication and enrichment. */
export interface RawCandidate {
  /** Stable id within a run (hash of the best available identity). */
  id: string;
  provider: SourceProvider;
  query: string;
  /** Language code: the article's own when the source says (GDELT), else the search edition's. */
  lang: string;
  categoryId: string;
  title: string;
  /** Publisher URL when known; for Google News this is the news.google.com link. */
  url: string;
  gnewsId: string | null;
  sourceName: string | null;
  sourceDomain: string | null;
  publishedAt: string | null;
  snippet: string | null;
}

/** Candidate after merging duplicates found by several queries/providers. */
export interface MergedCandidate extends RawCandidate {
  foundBy: { provider: SourceProvider; query: string }[];
  categoryHints: string[];
}
