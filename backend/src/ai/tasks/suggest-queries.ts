import { EDITION_IDS, type Subject, type SuggestQueriesResponse, type TaskModelSettings } from '@bio-majesty/shared';
import { z } from 'zod';
import { subjectContext } from '../prompts';
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
        edition: z
          .enum(EDITION_IDS)
          .describe('Google News edition to search, as COUNTRY:language (e.g. ID:id = Indonesia in Indonesian, SG:en = Singapore in English, US:en = United States in English)'),
      }),
    )
    .describe('Between 3 and 8 queries, each searching the edition where that coverage appears.'),
  exclude: z.array(z.string()).describe('Words or phrases that indicate an unrelated result (may be empty).'),
});

function instructions(subject: Subject): string {
  return `${subjectContext(subject)}

You help configure a news monitor. Given a category name and optional description, propose Google News search queries that will find relevant articles with good precision. Prefer specific entity names and the phrasing local media use. Search the edition of the subject's own country in its local language, and add English editions only where English coverage is plausible; for subjects without a home country, use the editions where most coverage appears. Avoid queries so broad that they would return mostly unrelated news (a bare company name may also match unrelated businesses, such as the look-alikes listed above).`;
}

export async function suggestQueries(
  input: { name: string; description: string },
  settings: TaskModelSettings,
  subject: Subject,
  usage?: UsageCollector,
): Promise<SuggestQueriesResponse> {
  const { output } = await runStructured({
    task: 'querySuggest',
    settings,
    schema: OutputSchema,
    name: 'category_search_config',
    instructions: instructions(subject),
    prompt: `Category name: ${input.name}\nDescription: ${input.description || '(none provided)'}`,
    maxOutputTokens: 4000,
    usage,
  });
  const seen = new Set<string>();
  const queries = output.queries
    .map((q) => ({ q: q.q.trim(), edition: q.edition }))
    .filter((q) => q.q.length >= 2 && !seen.has(`${q.edition}|${q.q}`) && seen.add(`${q.edition}|${q.q}`))
    .slice(0, 10);
  return {
    description: output.description.trim(),
    queries,
    exclude: [...new Set(output.exclude.map((e) => e.trim()).filter(Boolean))].slice(0, 20),
  };
}
