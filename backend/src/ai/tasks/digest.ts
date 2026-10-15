import type { Article, Category, Digest, TaskModelSettings } from '@bio-majesty/shared';
import { effectiveTags } from '@bio-majesty/shared';
import { z } from 'zod';
import { COMPANY_CONTEXT } from '../prompts';
import { runStructured } from '../run-task';
import type { UsageCollector } from '../usage';

const OutputSchema = z.object({
  title: z.string().describe('Short headline for the digest, e.g. "3 new items: Q3 results lead"'),
  summary: z.string().describe('Two to four sentences an executive can read in 15 seconds'),
  highlights: z
    .array(z.object({ articleId: z.string(), why: z.string().describe('One short sentence on why it matters') }))
    .describe('Up to 5 most important items, most important first'),
});

const INSTRUCTIONS = `${COMPANY_CONTEXT}

Write a brief digest of newly found news items for the executive, who will review them in the dashboard. Lead with what could matter most for PRDA's share price or the group's business. Be factual and concise; do not invent details beyond the item summaries.`;

export function digestCounts(articles: Article[]): Digest['counts'] {
  const counts = { total: articles.length, positive: 0, negative: 0, neutral: 0, undecided: 0 };
  for (const a of articles) counts[effectiveTags(a).sentiment]++;
  return counts;
}

export async function writeDigest(
  articles: Article[],
  categories: Category[],
  context: { runType: 'daily' | 'backfill'; categoryName?: string },
  settings: TaskModelSettings,
  usage?: UsageCollector,
): Promise<{ title: string; summary: string; highlights: Digest['highlights'] }> {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const sorted = [...articles].sort((a, b) => (b.suggestion?.relevance ?? 0) - (a.suggestion?.relevance ?? 0));
  const listing = sorted
    .slice(0, 60)
    .map((a) => {
      const tags = effectiveTags(a);
      const cats = tags.categoryIds.map((id) => names.get(id) ?? id).join(', ') || 'uncategorised';
      return `- id: ${a.id}\n  title: ${a.title}\n  source: ${a.sourceName ?? a.sourceDomain ?? 'unknown'}, ${a.publishedAt.slice(0, 10)}\n  sentiment: ${tags.sentiment}; categories: ${cats}; relevance: ${(a.suggestion?.relevance ?? 0).toFixed(2)}\n  summary: ${a.suggestion?.summary ?? a.snippet ?? ''}`;
    })
    .join('\n');

  const header =
    context.runType === 'backfill'
      ? `These ${articles.length} items were found by a historical search for the new category "${context.categoryName ?? ''}".`
      : `These ${articles.length} items were found by today's news run.`;

  const { output } = await runStructured({
    task: 'digest',
    settings,
    schema: OutputSchema,
    name: 'news_digest',
    instructions: INSTRUCTIONS,
    prompt: `${header}\n\n${listing}`,
    maxOutputTokens: 4000,
    usage,
  });

  const byId = new Map(articles.map((a) => [a.id, a]));
  const highlights = output.highlights
    .filter((h) => byId.has(h.articleId))
    .slice(0, 5)
    .map((h) => {
      const a = byId.get(h.articleId)!;
      return { articleId: a.id, title: a.title, sentiment: effectiveTags(a).sentiment, why: h.why.trim() };
    });
  return { title: output.title.trim(), summary: output.summary.trim(), highlights };
}
