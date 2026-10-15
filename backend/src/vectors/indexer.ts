import { effectiveSummary, effectiveTags, type Article } from '@bio-majesty/shared';
import type { UsageCollector } from '../ai/usage';
import { getJson, s3Keys } from '../storage/s3';
import { chunkText } from './chunk';
import { embedDocuments } from './embed';
import { deleteArticleVectors, putChunkVectors, vectorKey, type ChunkMetadata } from './store';

export interface StoredArticleText {
  url: string;
  title: string | null;
  text: string | null;
}

/**
 * Chunks for an article: chunk 0 is the headline + AI summary (good for
 * question-style queries), followed by chunks of the extracted body text.
 */
export function articleChunks(article: Article, text: string | null): string[] {
  const head = [article.title, effectiveSummary(article), article.sourceName ? `Source: ${article.sourceName}` : '']
    .filter(Boolean)
    .join('\n');
  const body = text ? chunkText(text).slice(0, 30) : article.snippet ? [article.snippet] : [];
  return [head, ...body];
}

export async function indexArticle(article: Article, usage?: UsageCollector): Promise<number> {
  const stored = await getJson<StoredArticleText>(s3Keys.articleText(article.id));
  const chunks = articleChunks(article, stored?.text ?? null);
  const vectors = await embedDocuments(chunks, usage);
  const tags = effectiveTags(article);
  const publishedAt = Math.floor(new Date(article.publishedAt).getTime() / 1000);
  // Remove stale chunks first (the article may have had more chunks before).
  await deleteArticleVectors(article.id);
  await putChunkVectors(
    vectors.map((vector, i) => ({
      key: vectorKey(article.id, i),
      vector,
      metadata: {
        articleId: article.id,
        chunk: i,
        publishedAt,
        categoryIds: tags.categoryIds,
        sentiment: tags.sentiment,
        title: article.title.slice(0, 500),
        text: chunks[i]!.slice(0, 6000),
        source: article.sourceName ?? article.sourceDomain ?? '',
      } satisfies ChunkMetadata,
    })),
  );
  return vectors.length;
}
