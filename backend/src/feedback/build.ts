import { effectiveTags, type Article, type Feedback, type FinalTags } from '@bio-majesty/shared';

/**
 * Turn a review decision into a labelled training example: what the AI
 * suggested, what the reviewer decided, and which fields differ.
 */
export function buildFeedback(
  article: Article,
  decision: Feedback['decision'],
  final: FinalTags | null,
  decidedAt = new Date().toISOString(),
): Feedback {
  const s = article.suggestion;
  const ai = s
    ? { model: s.model, categoryIds: s.categoryIds, sentiment: s.sentiment, summary: s.summary, rationale: s.rationale }
    : null;
  const tags = final ?? (decision === 'rejected' ? null : effectiveTags(article));
  const exec = tags
    ? {
        categoryIds: tags.categoryIds,
        sentiment: tags.sentiment,
        summary: tags.summary ?? ai?.summary ?? '',
        rationale: tags.rationale ?? ai?.rationale ?? '',
      }
    : null;

  const changed: Feedback['changed'] = [];
  if (decision === 'rejected') changed.push('relevance');
  if (ai && exec) {
    if ([...ai.categoryIds].sort().join() !== [...exec.categoryIds].sort().join()) changed.push('categories');
    if (ai.sentiment !== exec.sentiment) changed.push('sentiment');
    if (exec.summary.trim() !== ai.summary.trim()) changed.push('summary');
    if (exec.rationale.trim() !== ai.rationale.trim()) changed.push('rationale');
  }

  return {
    articleId: article.id,
    decision,
    decidedAt,
    title: article.title,
    sourceName: article.sourceName ?? article.sourceDomain,
    url: article.url,
    publishedAt: article.publishedAt,
    ai,
    exec,
    changed,
  };
}
