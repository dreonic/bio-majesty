import {
  BackfillRequestSchema,
  CategoryInputSchema,
  categoryColorFor,
  CategoryUpdateSchema,
  SuggestQueriesRequestSchema,
  type Category,
} from '@bio-majesty/shared';
import { suggestQueries } from '../../ai/tasks/suggest-queries';
import { startBackfillRun } from '../../lib/aws';
import { badRequest, conflict, json, noContent, notFound, parseBody, pathParam } from '../../lib/http';
import { randomId } from '../../lib/ids';
import { errorMessage } from '../../lib/logger';
import { createRouter } from '../../lib/router';
import { deleteCategory, getCategory, listCategories, putCategory, updateCategory } from '../../repo/categories';
import { getSettings } from '../../repo/settings';

function canBackfill(c: Category): boolean {
  return c.search.enabled && c.search.queries.length > 0;
}

async function launchBackfill(sub: string, category: Category, months: number): Promise<Category> {
  const pending = await updateCategory(sub, category.id, (c) => ({
    ...c,
    backfill: { ...c.backfill, months, status: 'pending', error: null },
  }));
  try {
    await startBackfillRun(sub, category.id, months);
  } catch (err) {
    await updateCategory(sub, category.id, (c) => ({
      ...c,
      active: true,
      backfill: { ...c.backfill, status: 'failed', error: errorMessage(err) },
    }));
    throw err;
  }
  return pending ?? category;
}

export const handler = createRouter({
  'GET /categories': async (_event, user) => json(200, { items: await listCategories(user.sub) }),

  'POST /categories': async (event, user) => {
    const input = parseBody(event, CategoryInputSchema);
    const existing = await listCategories(user.sub);
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
      backfill: { months: input.backfillMonths, status: 'none', runId: null, startedAt: null, completedAt: null, error: null },
      // Without a backfill the category joins the daily run immediately.
      active: input.backfillMonths === 0 || !input.search.enabled || input.search.queries.length === 0,
      createdAt: now,
      updatedAt: now,
    };
    await putCategory(user.sub, category);
    const saved = !category.active && canBackfill(category) ? await launchBackfill(user.sub, category, input.backfillMonths) : category;
    return json(201, saved);
  },

  'PATCH /categories/{id}': async (event, user) => {
    const patch = parseBody(event, CategoryUpdateSchema);
    const updated = await updateCategory(user.sub, pathParam(event, 'id'), (c) => ({
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
    if (!(await getCategory(user.sub, id))) throw notFound('Category not found');
    await deleteCategory(user.sub, id);
    return noContent();
  },

  'POST /categories/{id}/backfill': async (event, user) => {
    const { months } = parseBody(event, BackfillRequestSchema);
    const category = await getCategory(user.sub, pathParam(event, 'id'));
    if (!category) throw notFound('Category not found');
    if (!canBackfill(category)) throw badRequest('Add at least one search query before running a backfill');
    if (category.backfill.status === 'running' || category.backfill.status === 'pending') {
      throw conflict('A backfill is already in progress for this category');
    }
    return json(202, await launchBackfill(user.sub, category, months));
  },

  'POST /categories/suggest-queries': async (event, user) => {
    const input = parseBody(event, SuggestQueriesRequestSchema);
    const settings = await getSettings(user.sub);
    return json(200, await suggestQueries(input, settings.models.querySuggest, settings.profile));
  },
});
