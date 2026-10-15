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

async function launchBackfill(category: Category, months: number): Promise<Category> {
  const pending = await updateCategory(category.id, (c) => ({
    ...c,
    backfill: { ...c.backfill, months, status: 'pending', error: null },
  }));
  try {
    await startBackfillRun(category.id, months);
  } catch (err) {
    await updateCategory(category.id, (c) => ({
      ...c,
      active: true,
      backfill: { ...c.backfill, status: 'failed', error: errorMessage(err) },
    }));
    throw err;
  }
  return pending ?? category;
}

export const handler = createRouter({
  'GET /categories': async () => json(200, { items: await listCategories() }),

  'POST /categories': async (event) => {
    const input = parseBody(event, CategoryInputSchema);
    const existing = await listCategories();
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
    await putCategory(category);
    const saved = !category.active && canBackfill(category) ? await launchBackfill(category, input.backfillMonths) : category;
    return json(201, saved);
  },

  'PATCH /categories/{id}': async (event) => {
    const patch = parseBody(event, CategoryUpdateSchema);
    const updated = await updateCategory(pathParam(event, 'id'), (c) => ({
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

  'DELETE /categories/{id}': async (event) => {
    const id = pathParam(event, 'id');
    if (!(await getCategory(id))) throw notFound('Category not found');
    await deleteCategory(id);
    return noContent();
  },

  'POST /categories/{id}/backfill': async (event) => {
    const { months } = parseBody(event, BackfillRequestSchema);
    const category = await getCategory(pathParam(event, 'id'));
    if (!category) throw notFound('Category not found');
    if (!canBackfill(category)) throw badRequest('Add at least one search query before running a backfill');
    if (category.backfill.status === 'running' || category.backfill.status === 'pending') {
      throw conflict('A backfill is already in progress for this category');
    }
    return json(202, await launchBackfill(category, months));
  },

  'POST /categories/suggest-queries': async (event) => {
    const input = parseBody(event, SuggestQueriesRequestSchema);
    const settings = await getSettings();
    return json(200, await suggestQueries(input, settings.models.querySuggest));
  },
});
