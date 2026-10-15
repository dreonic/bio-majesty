import type { Category, TaskModelSettings } from '@bio-majesty/shared';
import { z } from 'zod';
import { errorMessage, logger } from '../../lib/logger';
import { categoriesBlock, COMPANY_CONTEXT, UNTRUSTED_NOTE, untrusted } from '../prompts';
import { runStructured } from '../run-task';
import type { UsageCollector } from '../usage';

export interface PrefilterItem {
  i: number;
  title: string;
  source: string | null;
  publishedAt: string | null;
  snippet: string | null;
}

export interface PrefilterDecision {
  i: number;
  relevant: boolean;
  reason: string;
  categoryIds: string[];
}

const OutputSchema = z.object({
  results: z.array(
    z.object({
      i: z.number().describe('Index of the headline as given in the input'),
      relevant: z.boolean(),
      reason: z.string().describe('A few words explaining the decision'),
      categoryIds: z.array(z.string()).describe('Likely category ids (may be empty)'),
    }),
  ),
});

const BATCH_SIZE = 50;

function instructions(categories: Category[], exclude: string[]): string {
  return `${COMPANY_CONTEXT}

You screen search results before articles are fetched and read in full. Mark a headline relevant if it is plausibly about the Prodia group, its businesses, or a topic covered by one of the categories below (for example regulation or competitors affecting Prodia). Mark it irrelevant when it clearly concerns something else — when unsure, keep it (relevant = true), because a person reviews everything that passes.
${exclude.length ? `\nResults mentioning any of these are usually unrelated: ${exclude.join(', ')}.` : ''}

${categoriesBlock(categories)}

${UNTRUSTED_NOTE}
Return exactly one result per input headline.`;
}

/**
 * Screen headlines in batches. Fails open: if the model call fails, items are
 * kept as relevant so nothing is silently lost.
 */
export async function prefilterHeadlines(
  items: PrefilterItem[],
  categories: Category[],
  exclude: string[],
  settings: TaskModelSettings,
  usage?: UsageCollector,
): Promise<PrefilterDecision[]> {
  const known = new Set(categories.map((c) => c.id));
  const decisions: PrefilterDecision[] = [];
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const batch = items.slice(start, start + BATCH_SIZE);
    const listing = batch
      .map((it) => `${it.i}. ${it.title}${it.source ? ` — ${it.source}` : ''}${it.publishedAt ? ` (${it.publishedAt.slice(0, 10)})` : ''}${it.snippet ? `\n   ${it.snippet.slice(0, 240)}` : ''}`)
      .join('\n');
    try {
      const { output } = await runStructured({
        task: 'prefilter',
        settings,
        schema: OutputSchema,
        name: 'headline_screening',
        instructions: instructions(categories, exclude),
        prompt: untrusted('search-results', listing),
        maxOutputTokens: 8000,
        usage,
      });
      const byIndex = new Map(output.results.map((r) => [r.i, r]));
      for (const it of batch) {
        const r = byIndex.get(it.i);
        decisions.push(
          r
            ? { i: it.i, relevant: r.relevant, reason: r.reason.slice(0, 200), categoryIds: r.categoryIds.filter((c) => known.has(c)) }
            : { i: it.i, relevant: true, reason: 'not screened', categoryIds: [] },
        );
      }
    } catch (err) {
      logger.error('Prefilter batch failed; keeping all items', { error: errorMessage(err), size: batch.length });
      for (const it of batch) decisions.push({ i: it.i, relevant: true, reason: 'prefilter unavailable', categoryIds: [] });
    }
  }
  return decisions;
}
