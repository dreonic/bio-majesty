import { SENTIMENTS, type Category, type Feedback, type Sentiment, type TaskModelSettings } from '@bio-majesty/shared';
import { z } from 'zod';
import {
  categoriesBlock,
  profileContext,
  sentimentBasis,
  sentimentRubric,
  UNTRUSTED_NOTE,
  untrusted,
  type ProfileContext,
} from '../prompts';
import { runStructured } from '../run-task';
import type { UsageCollector } from '../usage';

/** Numeric bounds are described rather than enforced in the schema (not all providers support them). */
export const ClassificationSchema = z.object({
  relevant: z.boolean().describe('False if the article turns out not to concern the subject described above or any category'),
  relevance: z.number().describe('0 to 1: how relevant the article is to the subject'),
  categoryIds: z.array(z.string()).describe('Ids of matching categories (may be empty)'),
  sentiment: z.enum(SENTIMENTS),
  rationale: z.string().describe('One or two sentences explaining the sentiment call for an executive'),
  confidence: z.number().describe('0 to 1: confidence in the sentiment call'),
  summary: z.string().describe('Two or three sentence English summary of the article'),
  publishedDate: z.string().nullable().describe('Publication date found in the article (YYYY-MM-DD), or null'),
});
export type RawClassification = z.infer<typeof ClassificationSchema>;

export interface Classification {
  relevant: boolean;
  relevance: number;
  categoryIds: string[];
  sentiment: Sentiment;
  rationale: string;
  confidence: number;
  summary: string;
  publishedDate: string | null;
  model: string;
}

export interface ArticleForClassification {
  title: string;
  sourceName: string | null;
  url: string;
  publishedAt: string | null;
  text: string | null;
  snippet: string | null;
  categoryHints: string[];
}

const MAX_TEXT_CHARS = 24_000;

export function classificationInstructions(categories: Category[], ctx: ProfileContext, examples: Feedback[] = []): string {
  return `${profileContext(ctx.profile)}

${sentimentRubric(ctx.profile, ctx.asset)}

${categoriesBlock(categories)}

You tag one news article for the executive's review queue. Suggest the matching categories, judge the sentiment for ${sentimentBasis(ctx.profile, ctx.asset)}, explain the call briefly, and summarise the article in English. If only a headline and snippet are available, work from those and lower your confidence accordingly.
${examples.length ? `\n${feedbackExamplesBlock(examples, categories)}\n` : ''}
${UNTRUSTED_NOTE}`;
}

/**
 * The exec's recent corrections, used as in-context examples when
 * Settings > Daily run > "Use past corrections" is on.
 */
export function feedbackExamplesBlock(examples: Feedback[], categories: Category[]): string {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const cats = (ids: string[]) => ids.map((id) => names.get(id) ?? id).join(', ') || 'none';
  const lines = examples.map((f, i) => {
    const head = `${i + 1}. "${f.title.slice(0, 200)}" (${f.sourceName ?? 'unknown source'}, ${f.publishedAt.slice(0, 10)})`;
    if (f.decision === 'rejected' || !f.exec) {
      const was = f.ai ? ` (it had been suggested as ${f.ai.sentiment}; categories: ${cats(f.ai.categoryIds)})` : '';
      return `${head}\n   The executive skipped this article as not useful${was}.`;
    }
    const parts = [head];
    if (f.ai) parts.push(`   Suggested: ${f.ai.sentiment}; categories: ${cats(f.ai.categoryIds)}`);
    parts.push(`   Executive decided: ${f.exec.sentiment}; categories: ${cats(f.exec.categoryIds)}`);
    if (f.changed.includes('rationale')) parts.push(`   Executive's reasoning: ${f.exec.rationale.slice(0, 400)}`);
    if (f.changed.includes('summary')) parts.push(`   Executive's preferred summary: ${f.exec.summary.slice(0, 500)}`);
    return parts.join('\n');
  });
  return `Recent corrections by the executive (learn their judgement on relevance, sentiment and summaries; follow these when similar cases come up):\n${lines.join('\n')}`;
}

export function classificationPrompt(article: ArticleForClassification, categories: Category[]): string {
  const hints = article.categoryHints
    .map((id) => categories.find((c) => c.id === id)?.name)
    .filter(Boolean);
  const body = article.text?.trim()
    ? article.text.slice(0, MAX_TEXT_CHARS)
    : `(Full text unavailable.)\n${article.snippet ?? ''}`;
  return [
    `Headline: ${article.title}`,
    `Source: ${article.sourceName ?? 'unknown'} (${article.url})`,
    `Listed date: ${article.publishedAt ?? 'unknown'}`,
    hints.length ? `Found while searching for: ${hints.join(', ')}` : '',
    untrusted('article', body),
  ]
    .filter(Boolean)
    .join('\n');
}

export function normalizeClassification(raw: RawClassification, categories: Category[], model: string): Classification {
  const known = new Set(categories.map((c) => c.id));
  const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);
  const date = raw.publishedDate && /^\d{4}-\d{2}-\d{2}$/.test(raw.publishedDate) ? raw.publishedDate : null;
  return {
    relevant: raw.relevant,
    relevance: clamp(raw.relevance),
    categoryIds: [...new Set(raw.categoryIds.filter((id) => known.has(id)))],
    sentiment: raw.sentiment,
    rationale: raw.rationale.trim().slice(0, 600),
    confidence: clamp(raw.confidence),
    summary: raw.summary.trim().slice(0, 1200),
    publishedDate: date,
    model,
  };
}

export async function classifyArticle(
  article: ArticleForClassification,
  categories: Category[],
  settings: TaskModelSettings,
  ctx: ProfileContext,
  usage?: UsageCollector,
  examples: Feedback[] = [],
): Promise<Classification> {
  const { output, modelRef } = await runStructured({
    task: 'tagging',
    settings,
    schema: ClassificationSchema,
    name: 'article_tagging',
    instructions: classificationInstructions(categories, ctx, examples),
    prompt: classificationPrompt(article, categories),
    maxOutputTokens: 6000,
    usage,
  });
  return normalizeClassification(output, categories, modelRef);
}
