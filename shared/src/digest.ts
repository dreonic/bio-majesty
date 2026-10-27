import { z } from 'zod';
import { IsoDateTime, SentimentSchema } from './common';

export const DigestHighlightSchema = z.object({
  articleId: z.string(),
  title: z.string(),
  sentiment: SentimentSchema,
  why: z.string(),
});

export const DigestSchema = z.object({
  /** The dashboard's calendar date, YYYY-MM-DD, plus a suffix for backfills. */
  id: z.string(),
  runId: z.string(),
  runType: z.enum(['daily', 'backfill']),
  title: z.string(),
  summary: z.string(),
  highlights: z.array(DigestHighlightSchema),
  /** The run's sentiment as a whole, judged by the digest model; null when it failed and a plain summary was used. */
  overall: z.object({ sentiment: SentimentSchema, reason: z.string() }).nullable(),
  counts: z.object({
    total: z.number(),
    positive: z.number(),
    negative: z.number(),
    neutral: z.number(),
    undecided: z.number(),
  }),
  createdAt: IsoDateTime,
});
export type Digest = z.infer<typeof DigestSchema>;
