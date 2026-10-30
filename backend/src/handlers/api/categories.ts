import {
  BackfillRequestSchema,
  CategoryInputSchema,
  categoryColorFor,
  CategoryUpdateSchema,
  SuggestQueriesRequestSchema,
  type BackfillPeriod,
  type Category,
} from '@bio-majesty/shared';
import { suggestQueries } from '../../ai/tasks/suggest-queries';
import { startBackfillRun, stopBackfillRuns } from '../../lib/aws';
import { badRequest, conflict, json, noContent, notFound, parseBody, pathParam } from '../../lib/http';
import { randomId } from '../../lib/ids';
import { errorMessage } from '../../lib/logger';
import { createProfileRouter } from '../../lib/router';
import { deleteCategory, getCategory, listCategories, putCategory, updateCategory } from '../../repo/categories';
import { cancelRun } from '../../repo/runs';
import { getSettings } from '../../repo/settings';
import type { ProfileId } from '../../repo/keys';

function canBackfill(c: Category): boolean {
  return c.search.enabled && c.search.queries.length > 0;
}

const inProgress = (c: Category) => c.backfill.status === 'pending' || c.backfill.status === 'running';

async function launchBackfill(profileId: ProfileId, category: Category, period: BackfillPeriod): Promise<Category> {
  const pending = await updateCategory(profileId, category.id, (c) => ({
    ...c,
    backfill: { ...c.backfill, period, status: 'pending', error: null },
  }));
  try {
    await startBackfillRun(profileId, category.id, period);
  } catch (err) {
    await updateCategory(profileId, category.id, (c) => ({
      ...c,
      active: true,
      backfill: { ...c.backfill, status: 'failed', error: errorMessage(err) },
    }));
    throw err;
  }
  return pending ?? category;
}

/** Stop the category's backfill and mark its run cancelled. Also clears a status left behind by a run that is gone. */
async function stopBackfill(profileId: ProfileId, category: Category): Promise<void> {
  await stopBackfillRuns(profileId, category.id);
  if (category.backfill.status === 'running' && category.backfill.runId) await cancelRun(profileId, category.backfill.runId);
}

export const handler = createProfileRouter({
  'GET /categories': async (_event, user) => json(200, { items: await listCategories(user.profileId) }),

  'POST /categories': async (event, user) => {
    const input = parseBody(event, CategoryInputSchema);
    const existing = await listCategories(user.profileId);
    if (existing.some((c) => c.name.toLowerCase() === input.name.toLowerCase())) {
      throw conflict(`A category named "${input.name}" already exists`);
    }
    const now = new Date().toISOString();
    const category: Category = {
      id: randomId(10),
      name: input.name,
      description: input.description,
      color: input.color ?? categoryColorFor(existing.length),
      search: input.search,
      backfill: { period: null, status: 'none', runId: null, startedAt: null, completedAt: null, error: null },
      // Without a backfill the category joins the daily run immediately.
      active: !input.backfillPeriod || !input.search.enabled || input.search.queries.length === 0,
      createdAt: now,
      updatedAt: now,
    };
    await putCategory(user.profileId, category);
    const saved = !category.active && input.backfillPeriod && canBackfill(category) ? await launchBackfill(user.profileId, category, input.backfillPeriod) : category;
    return json(201, saved);
  },

  'PATCH /categories/{id}': async (event, user) => {
    const patch = parseBody(event, CategoryUpdateSchema);
    const updated = await updateCategory(user.profileId, pathParam(event, 'id'), (c) => ({
      ...c,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      search: { ...c.search, ...(patch.search ?? {}) },
    }));
    if (!updated) throw notFound('Category not found');
    return json(200, updated);
  },

  'DELETE /categories/{id}': async (event, user) => {
    const id = pathParam(event, 'id');
    const category = await getCategory(user.profileId, id);
    if (!category) throw notFound('Category not found');
    // Otherwise the backfill would keep searching and tagging for a category that is gone.
    if (inProgress(category)) await stopBackfill(user.profileId, category);
    await deleteCategory(user.profileId, id);
    return noContent();
  },

  'POST /categories/{id}/backfill': async (event, user) => {
    const { period } = parseBody(event, BackfillRequestSchema);
    const category = await getCategory(user.profileId, pathParam(event, 'id'));
    if (!category) throw notFound('Category not found');
    if (!canBackfill(category)) throw badRequest('Add at least one search query before running a backfill');
    if (inProgress(category)) throw conflict('A backfill is already in progress for this category');
    return json(202, await launchBackfill(user.profileId, category, period));
  },

  'POST /categories/{id}/backfill/cancel': async (event, user) => {
    const category = await getCategory(user.profileId, pathParam(event, 'id'));
    if (!category) throw notFound('Category not found');
    if (!inProgress(category)) throw badRequest('This category has no backfill in progress');
    await stopBackfill(user.profileId, category);
    // Like a finished backfill, the category then joins the daily run. Items already tagged stay in the review queue.
    const updated = await updateCategory(user.profileId, category.id, (c) => ({
      ...c,
      active: true,
      backfill: { ...c.backfill, status: 'cancelled', completedAt: new Date().toISOString(), error: null },
    }));
    return json(200, updated ?? category);
  },

  'POST /categories/suggest-queries': async (event, user) => {
    const input = parseBody(event, SuggestQueriesRequestSchema);
    const settings = await getSettings(user.profileId);
    return json(200, await suggestQueries(input, settings.models.querySuggest, settings.subject));
  },
});
