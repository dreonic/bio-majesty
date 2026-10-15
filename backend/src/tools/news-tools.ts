import { effectiveSummary, effectiveTags, MARKET_TIME_ZONE, SentimentSchema, type Article, type Category, type Sentiment } from '@bio-majesty/shared';
import { z } from 'zod';
import { env } from '../lib/env';
import { localDate, parseDateInput } from '../lib/time';
import { batchGetArticles, getArticle, listArticles } from '../repo/articles';
import { listCategories } from '../repo/categories';
import { getQuote, queryDaily } from '../repo/stock';
import { getJson, s3Keys } from '../storage/s3';
import { embedQuery } from '../vectors/embed';
import type { StoredArticleText } from '../vectors/indexer';
import { queryVectors } from '../vectors/store';

/**
 * Read-only tools over the saved (approved) news. Plain async functions with
 * zod input schemas so they can back the in-app chat agent today and an MCP
 * endpoint or other agents later.
 */

const DateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`YYYY-MM-DD (${env.timeZone})`);
const TradingDateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD (IDX trading date)');

export const searchNewsInput = z.object({
  query: z.string().min(2).describe('What to look for, in English or Indonesian'),
  from: DateInput.optional(),
  to: DateInput.optional(),
  categoryIds: z.array(z.string()).optional().describe('Restrict to these category ids'),
  sentiment: SentimentSchema.optional(),
  limit: z.number().int().min(1).max(15).optional().describe('Maximum articles to return (default 8)'),
});

export const listNewsInput = z.object({
  from: DateInput.optional(),
  to: DateInput.optional(),
  categoryIds: z.array(z.string()).optional(),
  sentiment: SentimentSchema.optional(),
  keyword: z.string().optional().describe('Simple keyword match on title/summary'),
  limit: z.number().int().min(1).max(50).optional().describe('Default 25'),
});

export const getArticleInput = z.object({ id: z.string().describe('Article id from a previous tool result') });

export const getStockPricesInput = z.object({
  from: TradingDateInput,
  to: TradingDateInput.optional(),
});

export interface ToolArticle {
  id: string;
  title: string;
  url: string;
  sourceName: string | null;
  publishedAt: string;
  sentiment: Sentiment;
  categories: string[];
  summary: string;
}

function toToolArticle(a: Article, names: Map<string, string>): ToolArticle {
  const tags = effectiveTags(a);
  return {
    id: a.id,
    title: a.title,
    url: a.url,
    sourceName: a.sourceName ?? a.sourceDomain,
    publishedAt: localDate(new Date(a.publishedAt)),
    sentiment: tags.sentiment,
    categories: tags.categoryIds.map((id) => names.get(id) ?? id),
    summary: effectiveSummary(a),
  };
}

async function categoryNames(): Promise<Map<string, string>> {
  return new Map((await listCategories()).map((c) => [c.id, c.name]));
}

export async function searchNews(input: z.infer<typeof searchNewsInput>) {
  const limit = input.limit ?? 8;
  const vector = await embedQuery(input.query);
  const hits = await queryVectors(vector, Math.min(100, limit * 5), {
    from: input.from ? parseDateInput(input.from) : undefined,
    to: input.to ? parseDateInput(input.to, true) : undefined,
    categoryIds: input.categoryIds,
    sentiments: input.sentiment ? [input.sentiment] : undefined,
  });
  const best = new Map<string, { distance: number; snippets: string[] }>();
  for (const h of hits) {
    const cur = best.get(h.metadata.articleId) ?? { distance: h.distance, snippets: [] };
    cur.distance = Math.min(cur.distance, h.distance);
    if (cur.snippets.length < 2 && h.metadata.chunk > 0) cur.snippets.push(h.metadata.text.slice(0, 700));
    best.set(h.metadata.articleId, cur);
  }
  const ranked = [...best.entries()].sort((a, b) => a[1].distance - b[1].distance).slice(0, limit);
  const articles = (await batchGetArticles(ranked.map(([id]) => id))).filter((a) => a.status === 'APPROVED');
  const names = await categoryNames();
  const byId = new Map(articles.map((a) => [a.id, a]));
  return {
    results: ranked
      .filter(([id]) => byId.has(id))
      .map(([id, info]) => ({
        ...toToolArticle(byId.get(id)!, names),
        relevance: Number((1 - info.distance).toFixed(3)),
        excerpts: info.snippets,
      })),
  };
}

export async function listNews(input: z.infer<typeof listNewsInput>) {
  const limit = input.limit ?? 25;
  const { items, nextCursor } = await listArticles({
    status: 'APPROVED',
    from: input.from ? parseDateInput(input.from) : undefined,
    to: input.to ? parseDateInput(input.to, true) : undefined,
    categories: input.categoryIds,
    sentiments: input.sentiment ? [input.sentiment] : undefined,
    q: input.keyword,
    limit,
  });
  const names = await categoryNames();
  return { count: items.length, truncated: nextCursor !== null, articles: items.map((a) => toToolArticle(a, names)) };
}

export async function getArticleTool(input: z.infer<typeof getArticleInput>) {
  const article = await getArticle(input.id);
  if (!article || article.status !== 'APPROVED') return { error: 'Article not found among saved news.' };
  const stored = await getJson<StoredArticleText>(s3Keys.articleText(article.id));
  const names = await categoryNames();
  return {
    ...toToolArticle(article, names),
    rationale: article.final?.rationale ?? article.suggestion?.rationale ?? null,
    text: stored?.text ? stored.text.slice(0, 12_000) : null,
  };
}

export async function getStockPrices(input: z.infer<typeof getStockPricesInput>, symbol: string) {
  // Trading dates are Jakarta days; a Singapore midnight would fall on the previous trading date.
  const from = parseDateInput(input.from, false, MARKET_TIME_ZONE);
  const to = input.to ? parseDateInput(input.to, true, MARKET_TIME_ZONE) : new Date();
  const candles = await queryDaily(symbol, from, to);
  const quote = await getQuote(symbol);
  if (!candles.length) return { symbol, candles: [], summary: null, latestQuote: quote };
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const step = Math.max(1, Math.ceil(candles.length / 120));
  return {
    symbol,
    summary: {
      from: new Date(first.time * 1000).toISOString().slice(0, 10),
      to: new Date(last.time * 1000).toISOString().slice(0, 10),
      firstClose: first.close,
      lastClose: last.close,
      changePercent: Number((((last.close - first.close) / first.close) * 100).toFixed(2)),
      high: Math.max(...candles.map((c) => c.high)),
      low: Math.min(...candles.map((c) => c.low)),
      averageVolume: Math.round(candles.reduce((s, c) => s + c.volume, 0) / candles.length),
    },
    // Downsampled daily closes (max ~120 points) to keep the context small.
    closes: candles
      .filter((_, i) => i % step === 0 || i === candles.length - 1)
      .map((c) => ({ date: new Date(c.time * 1000).toISOString().slice(0, 10), close: c.close, volume: c.volume })),
    latestQuote: quote,
  };
}

export async function listCategoriesTool(): Promise<Pick<Category, 'id' | 'name' | 'description'>[]> {
  return (await listCategories()).map(({ id, name, description }) => ({ id, name, description }));
}
