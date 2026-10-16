import { z } from 'zod';
import {
  ArticleStatusSchema,
  IdSchema,
  IsoDateTime,
  SentimentSchema,
  paginated,
} from './common';

export const SuggestionSchema = z.object({
  categoryIds: z.array(z.string()),
  sentiment: SentimentSchema,
  rationale: z.string(),
  /** 0..1 — how confident the model is in its sentiment call. */
  confidence: z.number(),
  /** 0..1 — how relevant the article is to the Prodia group. */
  relevance: z.number(),
  summary: z.string(),
  model: z.string(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

/** The exec's decision. Summary/rationale are present only when the exec edited the AI's text. */
export const FinalTagsSchema = z.object({
  categoryIds: z.array(z.string()),
  sentiment: SentimentSchema,
  summary: z.string().optional(),
  rationale: z.string().optional(),
});
export type FinalTags = z.infer<typeof FinalTagsSchema>;

export const ArticleOriginSchema = z.object({
  type: z.enum(['daily', 'backfill', 'manual']),
  runId: z.string(),
  categoryId: z.string().nullable(),
});

export const TEXT_STATUSES = ['ok', 'paywalled', 'failed', 'skipped'] as const;

export const ArticleSchema = z.object({
  id: IdSchema,
  url: z.string(),
  /** Original discovery link (e.g. Google News redirect) when it differs from `url`. */
  sourceUrl: z.string().nullable(),
  title: z.string(),
  sourceName: z.string().nullable(),
  sourceDomain: z.string().nullable(),
  publishedAt: IsoDateTime,
  lang: z.string().nullable(),
  snippet: z.string().nullable(),
  textStatus: z.enum(TEXT_STATUSES),
  status: ArticleStatusSchema,
  suggestion: SuggestionSchema.nullable(),
  final: FinalTagsSchema.nullable(),
  filterReason: z.string().nullable(),
  origin: ArticleOriginSchema,
  foundBy: z.array(z.object({ provider: z.string(), query: z.string() })),
  createdAt: IsoDateTime,
  reviewedAt: IsoDateTime.nullable(),
  indexedAt: IsoDateTime.nullable(),
});
export type Article = z.infer<typeof ArticleSchema>;

/** Effective tags: the exec's decision if reviewed, otherwise the AI suggestion. */
export function effectiveTags(a: Pick<Article, 'final' | 'suggestion'>): FinalTags {
  if (a.final) return a.final;
  return {
    categoryIds: a.suggestion?.categoryIds ?? [],
    sentiment: a.suggestion?.sentiment ?? 'undecided',
  };
}

/** Summary shown to users: the exec's edit if any, otherwise the AI's. */
export function effectiveSummary(a: Pick<Article, 'final' | 'suggestion' | 'snippet'>): string {
  return a.final?.summary ?? a.suggestion?.summary ?? a.snippet ?? '';
}

export function effectiveRationale(a: Pick<Article, 'final' | 'suggestion'>): string {
  return a.final?.rationale ?? a.suggestion?.rationale ?? '';
}

export const ArticleDetailSchema = ArticleSchema.extend({
  text: z.string().nullable(),
});
export type ArticleDetail = z.infer<typeof ArticleDetailSchema>;

export const NewsQuerySchema = z.object({
  status: ArticleStatusSchema.default('APPROVED'),
  /** ISO date or datetime (inclusive). */
  from: z.string().optional(),
  to: z.string().optional(),
  categories: z.array(z.string()).optional(),
  sentiments: z.array(SentimentSchema).optional(),
  q: z.string().trim().max(200).optional(),
  runId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type NewsQuery = z.infer<typeof NewsQuerySchema>;

export const NewsListResponseSchema = paginated(ArticleSchema);
export type NewsListResponse = z.infer<typeof NewsListResponseSchema>;

export const REVIEW_ACTIONS = ['approve', 'reject', 'update', 'restore', 'unsave'] as const;

export const ReviewRequestSchema = z.object({
  action: z.enum(REVIEW_ACTIONS),
  categoryIds: z.array(z.string()).optional(),
  sentiment: SentimentSchema.optional(),
  /** Exec-edited text (stored as training feedback for the classifier). */
  summary: z.string().trim().max(2000).optional(),
  rationale: z.string().trim().max(1000).optional(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const BulkReviewRequestSchema = z.object({
  ids: z.array(IdSchema).min(1).max(100),
  /** Bulk actions always use each item's current suggestion. */
  action: z.enum(['approve', 'reject']),
});
export type BulkReviewRequest = z.infer<typeof BulkReviewRequestSchema>;

export const BulkReviewResponseSchema = z.object({
  updated: z.number(),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});

export const PendingCountsSchema = z.object({
  pending: z.number(),
  filtered: z.number(),
  /** Skipped by the exec (the recycle bin). */
  skipped: z.number(),
});
export type PendingCounts = z.infer<typeof PendingCountsSchema>;
