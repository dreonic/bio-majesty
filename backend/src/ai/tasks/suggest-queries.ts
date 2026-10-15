import type { SuggestQueriesResponse, TaskModelSettings } from '@bio-majesty/shared';
import { z } from 'zod';
import { COMPANY_CONTEXT } from '../prompts';
import { runStructured } from '../run-task';
import type { UsageCollector } from '../usage';

const OutputSchema = z.object({
  description: z
    .string()
    .describe('One or two sentences describing what belongs in this category, written for a tagging model.'),
  queries: z
    .array(
      z.object({
        q: z.string().describe('Google News query. Use "quotes" for exact phrases and OR between alternatives.'),
        lang: z.enum(['id', 'en']).describe('Language edition to search: id = Indonesian, en = English'),
      }),
    )
    .describe('Between 3 and 8 queries mixing Indonesian and English.'),
  exclude: z.array(z.string()).describe('Words or phrases that indicate an unrelated result (may be empty).'),
});

const INSTRUCTIONS = `${COMPANY_CONTEXT}

You help configure a news monitor. Given a category name and optional description, propose Google News search queries that will find relevant articles with good precision. Prefer specific entity names and common Indonesian phrasing used by local business media; include English variants only where English coverage is plausible. Avoid queries so broad that they would return mostly unrelated news (for example the bare word "Prodia" also matches an unrelated AI company).`;

export async function suggestQueries(
  input: { name: string; description: string },
  settings: TaskModelSettings,
  usage?: UsageCollector,
): Promise<SuggestQueriesResponse> {
  const { output } = await runStructured({
    task: 'querySuggest',
    settings,
    schema: OutputSchema,
    name: 'category_search_config',
    instructions: INSTRUCTIONS,
    prompt: `Category name: ${input.name}\nDescription: ${input.description || '(none provided)'}`,
    maxOutputTokens: 4000,
    usage,
  });
  const seen = new Set<string>();
  const queries = output.queries
    .map((q) => ({ q: q.q.trim(), lang: q.lang }))
    .filter((q) => q.q.length >= 2 && !seen.has(`${q.lang}|${q.q}`) && seen.add(`${q.lang}|${q.q}`))
    .slice(0, 10);
  return {
    description: output.description.trim(),
    queries,
    exclude: [...new Set(output.exclude.map((e) => e.trim()).filter(Boolean))].slice(0, 20),
  };
}
