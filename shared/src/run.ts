import { z } from 'zod';
import { IsoDateTime } from './common';

export const RUN_TYPES = ['daily', 'backfill'] as const;
export const RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;

export const RunStatsSchema = z.object({
  searched: z.number(),
  found: z.number(),
  duplicates: z.number(),
  filtered: z.number(),
  pending: z.number(),
  errors: z.number(),
});
export type RunStats = z.infer<typeof RunStatsSchema>;

export const UsageEntrySchema = z.object({
  task: z.string(),
  model: z.string(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type UsageEntry = z.infer<typeof UsageEntrySchema>;

export const RunSchema = z.object({
  id: z.string(),
  type: z.enum(RUN_TYPES),
  status: z.enum(RUN_STATUSES),
  categoryId: z.string().nullable(),
  window: z.object({ from: IsoDateTime, to: IsoDateTime }),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  stats: RunStatsSchema,
  usage: z.array(UsageEntrySchema),
  error: z.string().nullable(),
  trigger: z.enum(['schedule', 'manual', 'category']),
});
export type Run = z.infer<typeof RunSchema>;

export const EMPTY_STATS: RunStats = {
  searched: 0,
  found: 0,
  duplicates: 0,
  filtered: 0,
  pending: 0,
  errors: 0,
};
