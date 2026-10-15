import { z } from 'zod';
import { IsoDateTime, SentimentSchema } from './common';

export const DigestHighlightSchema = z.object({
  articleId: z.string(),
  title: z.string(),
  sentiment: SentimentSchema,
  why: z.string(),
});

export const DigestSchema = z.object({
  /** The exec's calendar date, YYYY-MM-DD, plus a suffix for backfills. */
  id: z.string(),
  runId: z.string(),
  runType: z.enum(['daily', 'backfill']),
  title: z.string(),
  summary: z.string(),
  highlights: z.array(DigestHighlightSchema),
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
