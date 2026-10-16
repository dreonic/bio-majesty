import {
  BulkReviewRequestSchema,
  DeleteNewsRequestSchema,
  NewsQuerySchema,
  ReviewRequestSchema,
  type Article,
  type ArticleDetail,
  type DeleteNewsResponse,
  type FinalTags,
  type ReviewRequest,
} from '@bio-majesty/shared';
import { badRequest, json, notFound, parseBody, parseQuery, pathParam } from '../../lib/http';
import { buildFeedback } from '../../feedback/build';
import { errorMessage, logger } from '../../lib/logger';
import { createRouter } from '../../lib/router';
import { parseDateInput } from '../../lib/time';
import {
  applyReview,
  articleIdPages,
  countByStatus,
  deleteArticles,
  getArticle,
  listArticles,
  type ReviewChange,
} from '../../repo/articles';
import { listCategories } from '../../repo/categories';
import { latestDigests } from '../../repo/digests';
import { feedbackStats, putFeedback } from '../../repo/feedback';
import { deleteObjects, getJson, s3Keys } from '../../storage/s3';
import type { StoredArticleText } from '../../vectors/indexer';

/** Translate a review action into a status/tag change, validating transitions. */
export function reviewChange(article: Article, req: ReviewRequest, knownCategories: Set<string>): ReviewChange {
  // Edited text is kept only when it differs from the AI's version.
  const edited = (field: 'summary' | 'rationale') => {
    const proposed = (req[field] ?? article.final?.[field])?.trim();
    return proposed && proposed !== article.suggestion?.[field]?.trim() ? proposed : undefined;
  };
  const tags = (): FinalTags => {
    const summary = edited('summary');
    const rationale = edited('rationale');
    return {
      categoryIds: (req.categoryIds ?? article.final?.categoryIds ?? article.suggestion?.categoryIds ?? []).filter((id) =>
        knownCategories.has(id),
      ),
      sentiment: req.sentiment ?? article.final?.sentiment ?? article.suggestion?.sentiment ?? 'undecided',
      ...(summary ? { summary } : {}),
      ...(rationale ? { rationale } : {}),
    };
  };
  switch (req.action) {
    case 'approve':
      return { status: 'APPROVED', final: tags() };
    case 'reject':
      return { status: 'REJECTED' };
    case 'update':
      return { final: tags() };
    case 'restore':
      if (article.status !== 'FILTERED' && article.status !== 'REJECTED') {
        throw badRequest('Only filtered or skipped articles can be restored');
      }
      return { status: 'PENDING' };
    case 'unsave':
      if (article.status !== 'APPROVED') throw badRequest('Only saved articles can be un-saved');
      return { status: 'PENDING' };
  }
}

const FEEDBACK_DECISIONS = { approve: 'approved', reject: 'rejected', update: 'edited' } as const;

/** A delete by status stops after this long (API Gateway gives up at 29 s) and reports `more`. */
const DELETE_TIME_BUDGET_MS = 20_000;

/** Store the decision as training data (never fails the request). */
async function recordFeedback(before: Article, after: Article, action: ReviewRequest['action']): Promise<void> {
  const decision = FEEDBACK_DECISIONS[action as keyof typeof FEEDBACK_DECISIONS];
  if (!decision) return;
  try {
    await putFeedback(buildFeedback(before, decision, after.final));
  } catch (err) {
    logger.error('Failed to store review feedback', { error: errorMessage(err), articleId: before.id });
  }
}

async function categoryIdSet(): Promise<Set<string>> {
  return new Set((await listCategories()).map((c) => c.id));
}

export const handler = createRouter({
  'GET /news': async (event) => {
    const q = parseQuery(event, NewsQuerySchema, ['categories', 'sentiments']);
    const result = await listArticles({
      status: q.status,
      from: q.from ? parseDateInput(q.from) : undefined,
      to: q.to ? parseDateInput(q.to, true) : undefined,
      categories: q.categories,
      sentiments: q.sentiments,
      q: q.q,
      limit: q.limit,
      cursor: q.cursor,
    });
    return json(200, result);
  },

  'GET /news/counts': async () => {
    const [pending, filtered, skipped] = await Promise.all([countByStatus('PENDING'), countByStatus('FILTERED'), countByStatus('REJECTED')]);
    return json(200, { pending, filtered, skipped });
  },

  'GET /news/{id}': async (event) => {
    const article = await getArticle(pathParam(event, 'id'));
    if (!article) throw notFound('Article not found');
    const stored = await getJson<StoredArticleText>(s3Keys.articleText(article.id));
    const detail: ArticleDetail = { ...article, text: stored?.text ?? null };
    return json(200, detail);
  },

  'PATCH /news/{id}': async (event) => {
    const req = parseBody(event, ReviewRequestSchema);
    const article = await getArticle(pathParam(event, 'id'));
    if (!article) throw notFound('Article not found');
    const updated = await applyReview(article, reviewChange(article, req, await categoryIdSet()));
    await recordFeedback(article, updated, req.action);
    return json(200, updated);
  },

  'POST /news/bulk': async (event) => {
    const req = parseBody(event, BulkReviewRequestSchema);
    const known = await categoryIdSet();
    const failed: { id: string; error: string }[] = [];
    let updated = 0;
    for (const id of req.ids) {
      try {
        const article = await getArticle(id);
        if (!article) throw new Error('not found');
        const after = await applyReview(article, reviewChange(article, { action: req.action }, known));
        await recordFeedback(article, after, req.action);
        updated++;
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return json(200, { updated, failed });
  },

  'POST /news/delete': async (event) => {
    const req = parseBody(event, DeleteNewsRequestSchema);
    const deadline = Date.now() + DELETE_TIME_BUDGET_MS;
    const res: DeleteNewsResponse = { deleted: 0, failed: [], more: false };
    const deletedIds: string[] = [];
    const remove = async (ids: string[]) => {
      const { deleted, notDeletable } = await deleteArticles(ids);
      res.deleted += deleted.length;
      deletedIds.push(...deleted);
      res.failed.push(...notDeletable.map((id) => ({ id, error: 'not skipped or filtered' })));
    };
    if ('ids' in req) {
      await remove(req.ids);
    } else {
      // Each page continues after the last key read, so deleting as we go doesn't disturb the listing.
      for await (const ids of articleIdPages(req.status)) {
        await remove(ids);
        if (Date.now() > deadline) {
          res.more = true;
          break;
        }
      }
    }
    // The extracted text of skipped articles; missing objects (filtered articles have none) are fine.
    try {
      await deleteObjects(deletedIds.map((id) => s3Keys.articleText(id)));
    } catch (err) {
      logger.error('Failed to delete article texts', { error: errorMessage(err), count: deletedIds.length });
    }
    return json(200, res);
  },

  'GET /feedback/stats': async () => json(200, await feedbackStats()),

  'GET /digest/latest': async () => {
    const [digest] = await latestDigests(1);
    return json(200, { digest: digest ?? null });
  },
});
