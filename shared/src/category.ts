import { z } from 'zod';
import { IdSchema, IsoDateTime, LangSchema } from './common';

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  lang: LangSchema,
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const CategorySourcesSchema = z.object({
  googleNews: z.boolean().default(true),
  gdelt: z.boolean().default(true),
});
export type CategorySources = z.infer<typeof CategorySourcesSchema>;

export const BACKFILL_STATUSES = ['none', 'pending', 'running', 'done', 'failed'] as const;
export const BackfillStatusSchema = z.enum(BACKFILL_STATUSES);
export type BackfillStatus = z.infer<typeof BackfillStatusSchema>;

export const CategorySchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  /** Used verbatim in LLM prompts to decide whether an article belongs here. */
  description: z.string().max(1000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  search: z.object({
    /** Label-only categories are used for tagging but never searched. */
    enabled: z.boolean(),
    queries: z.array(SearchQuerySchema).max(20),
    /** Terms that mark a result as irrelevant (passed to the prefilter and as -term in queries). */
    exclude: z.array(z.string().trim().min(1).max(60)).max(20),
    sources: CategorySourcesSchema,
  }),
  backfill: z.object({
    months: z.number().int().min(0).max(36),
    status: BackfillStatusSchema,
    runId: z.string().nullable(),
    startedAt: IsoDateTime.nullable(),
    completedAt: IsoDateTime.nullable(),
    error: z.string().nullable(),
  }),
  /** Included in the daily run (set after the initial backfill completes). */
  active: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Category = z.infer<typeof CategorySchema>;

export const CategoryInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  search: z
    .object({
      enabled: z.boolean().default(true),
      queries: z.array(SearchQuerySchema).max(20).default([]),
      exclude: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
      sources: CategorySourcesSchema.default({ googleNews: true, gdelt: true }),
    })
    .default({ enabled: true, queries: [], exclude: [], sources: { googleNews: true, gdelt: true } }),
  /** Months to search back when the category is created. 0 = no backfill. */
  backfillMonths: z.number().int().min(0).max(36).default(6),
});
export type CategoryInput = z.input<typeof CategoryInputSchema>;

export const CategoryUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(1000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  search: z
    .object({
      enabled: z.boolean(),
      queries: z.array(SearchQuerySchema).max(20),
      exclude: z.array(z.string().trim().min(1).max(60)).max(20),
      sources: CategorySourcesSchema,
    })
    .partial()
    .optional(),
  active: z.boolean().optional(),
});
export type CategoryUpdate = z.infer<typeof CategoryUpdateSchema>;

export const BackfillRequestSchema = z.object({
  months: z.number().int().min(1).max(36),
});

export const SuggestQueriesRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).default(''),
});

export const SuggestQueriesResponseSchema = z.object({
  description: z.string(),
  queries: z.array(SearchQuerySchema),
  exclude: z.array(z.string()),
});
export type SuggestQueriesResponse = z.infer<typeof SuggestQueriesResponseSchema>;

/**
 * Validated categorical palette (fixed order, colorblind-checked; see
 * docs/design.md). Categories are assigned these in creation order; past the
 * 8th they get the neutral overflow color instead of cycling hues.
 */
export const CATEGORY_COLORS = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948',
] as const;
export const CATEGORY_OVERFLOW_COLOR = '#898781';

export function categoryColorFor(index: number): string {
  return CATEGORY_COLORS[index] ?? CATEGORY_OVERFLOW_COLOR;
}
