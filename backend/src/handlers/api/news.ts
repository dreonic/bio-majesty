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
import { badRequest, json, notFound, parseBody, parseQuery, pathParam, type ProfileUser } from '../../lib/http';
import { buildFeedback } from '../../feedback/build';
import { errorMessage, logger } from '../../lib/logger';
import { createProfileRouter } from '../../lib/router';
import { parseDateInput } from '../../lib/time';
import {
  applyReview,
  articleIdPages,
  countByStatus,
  getArticle,
  listArticles,
  removeArticles,
  type ReviewChange,
} from '../../repo/articles';
import { listCategories } from '../../repo/categories';
import { latestDigests } from '../../repo/digests';
import { feedbackStats, putFeedback } from '../../repo/feedback';
import { deleteObjects, getJson, s3Keys } from '../../storage/s3';
import type { StoredArticleText } from '../../vectors/indexer';
import type { ProfileId } from '../../repo/keys';

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

/** Store the decision as the profile's training data (never fails the request). */
async function recordFeedback(user: ProfileUser, before: Article, after: Article, action: ReviewRequest['action']): Promise<void> {
  const decision = FEEDBACK_DECISIONS[action as keyof typeof FEEDBACK_DECISIONS];
  if (!decision) return;
  try {
    await putFeedback(user.profileId, buildFeedback(before, decision, after.final));
  } catch (err) {
    logger.error('Failed to store review feedback', { error: errorMessage(err), articleId: before.id });
  }
}

async function categoryIdSet(profileId: ProfileId): Promise<Set<string>> {
  return new Set((await listCategories(profileId)).map((c) => c.id));
}

export const handler = createProfileRouter({
  'GET /news': async (event, user) => {
    const q = parseQuery(event, NewsQuerySchema, ['categories', 'sentiments']);
    const result = await listArticles(user.profileId, {
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

  'GET /news/counts': async (_event, user) => {
    const [pending, filtered, skipped] = await Promise.all(
      (['PENDING', 'FILTERED', 'REJECTED'] as const).map((status) => countByStatus(user.profileId, status)),
    );
    return json(200, { pending, filtered, skipped });
  },

  'GET /news/{id}': async (event, user) => {
    const article = await getArticle(user.profileId, pathParam(event, 'id'));
    if (!article) throw notFound('Article not found');
    const stored = await getJson<StoredArticleText>(s3Keys.articleText(user.profileId, article.id));
    const detail: ArticleDetail = { ...article, text: stored?.text ?? null };
    return json(200, detail);
  },

  'PATCH /news/{id}': async (event, user) => {
    const req = parseBody(event, ReviewRequestSchema);
    const article = await getArticle(user.profileId, pathParam(event, 'id'));
    if (!article) throw notFound('Article not found');
    const updated = await applyReview(user.profileId, article, reviewChange(article, req, await categoryIdSet(user.profileId)));
    await recordFeedback(user, article, updated, req.action);
    return json(200, updated);
  },

  'POST /news/bulk': async (event, user) => {
    const req = parseBody(event, BulkReviewRequestSchema);
    const known = await categoryIdSet(user.profileId);
    const failed: { id: string; error: string }[] = [];
    let updated = 0;
    for (const id of req.ids) {
      try {
        const article = await getArticle(user.profileId, id);
        if (!article) throw new Error('not found');
        const after = await applyReview(user.profileId, article, reviewChange(article, { action: req.action }, known));
        await recordFeedback(user, article, after, req.action);
        updated++;
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return json(200, { updated, failed });
  },

  /**
   * Recycle-bin articles are deleted for good and forgotten (a later run can find them again);
   * filtered articles are hidden but remembered (later runs keep filtering them out).
   */
  'POST /news/delete': async (event, user) => {
    const req = parseBody(event, DeleteNewsRequestSchema);
    const deadline = Date.now() + DELETE_TIME_BUDGET_MS;
    const res: DeleteNewsResponse = { deleted: 0, failed: [], more: false };
    const removedIds: string[] = [];
    const remove = async (ids: string[]) => {
      const { deleted, hidden, notDeletable } = await removeArticles(user.profileId, ids);
      res.deleted += deleted.length + hidden.length;
      removedIds.push(...deleted, ...hidden);
      res.failed.push(...notDeletable.map((id) => ({ id, error: 'not skipped or filtered' })));
    };
    if ('ids' in req) {
      await remove(req.ids);
    } else {
      // Each page continues after the last key read, so removing as we go doesn't disturb the listing.
      for await (const ids of articleIdPages(user.profileId, req.status)) {
        await remove(ids);
        if (Date.now() > deadline) {
          res.more = true;
          break;
        }
      }
    }
    // Their extracted texts are no longer shown; missing objects (most filtered articles have none) are fine.
    try {
      await deleteObjects(removedIds.map((id) => s3Keys.articleText(user.profileId, id)));
    } catch (err) {
      logger.error('Failed to delete article texts', { error: errorMessage(err), count: removedIds.length });
    }
    return json(200, res);
  },

  'GET /feedback/stats': async (_event, user) => json(200, await feedbackStats(user.profileId)),

  'GET /digest/latest': async (_event, user) => {
    const [digest] = await latestDigests(user.profileId, 1);
    return json(200, { digest: digest ?? null });
  },
});
