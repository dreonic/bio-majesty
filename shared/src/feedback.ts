import { z } from 'zod';
import { IsoDateTime, SentimentSchema } from './common';

/**
 * One review decision by the exec, stored as a labelled example for future
 * classifier training (and, when enabled in Settings, as in-context examples
 * for the tagging model).
 */
export const FeedbackSchema = z.object({
  articleId: z.string(),
  decision: z.enum(['approved', 'rejected', 'edited']),
  decidedAt: IsoDateTime,
  title: z.string(),
  sourceName: z.string().nullable(),
  url: z.string(),
  publishedAt: IsoDateTime,
  ai: z
    .object({
      model: z.string(),
      categoryIds: z.array(z.string()),
      sentiment: SentimentSchema,
      summary: z.string(),
      rationale: z.string(),
    })
    .nullable(),
  exec: z
    .object({
      categoryIds: z.array(z.string()),
      sentiment: SentimentSchema,
      summary: z.string(),
      rationale: z.string(),
    })
    .nullable(),
  /** Which fields the exec changed relative to the AI suggestion. */
  changed: z.array(z.enum(['categories', 'sentiment', 'summary', 'rationale', 'relevance'])),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

export const FeedbackStatsSchema = z.object({
  total: z.number(),
  corrections: z.number(),
});
export type FeedbackStats = z.infer<typeof FeedbackStatsSchema>;
