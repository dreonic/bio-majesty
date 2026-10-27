import { z } from 'zod';

/**
 * Sentiment of a news item, judged as the account's profile says (the price of one of its
 * assets, or the subject itself): positive / negative = likely to help / hurt,
 * neutral = no meaningful effect expected, undecided = mixed or unclear.
 */
export const SENTIMENTS = ['positive', 'negative', 'neutral', 'undecided'] as const;
export const SentimentSchema = z.enum(SENTIMENTS);
export type Sentiment = z.infer<typeof SentimentSchema>;

/**
 * Lifecycle of a discovered article.
 * - PENDING: suggested by the pipeline, waiting for review
 * - APPROVED: saved by the reviewer (shown in the News tab, indexed for chat)
 * - REJECTED: skipped by the reviewer (the recycle bin; later runs drop it while it is there)
 * - FILTERED: dropped by the AI headline prefilter (restorable for 30 days)
 */
export const ARTICLE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'FILTERED'] as const;
export const ArticleStatusSchema = z.enum(ARTICLE_STATUSES);
export type ArticleStatus = z.infer<typeof ArticleStatusSchema>;

/** ISO 8601 timestamp string (UTC). */
export const IsoDateTime = z.string().min(10);

/** Opaque identifier (hash or random id). */
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/, 'invalid id');

/** Standard error payload returned by the API. */
export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Cursor-paginated list wrapper. */
export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
