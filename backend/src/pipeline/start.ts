import type { Category, Settings } from '@bio-majesty/shared';
import { randomId, timeId } from '../lib/ids';
import { addDays, addMonths } from '../lib/time';
import { getCategory, listCategories, updateCategory } from '../repo/categories';
import { createRun, lastSuccessfulDailyRun } from '../repo/runs';
import { getSettings } from '../repo/settings';
import { GDELT_MAX_LOOKBACK_DAYS } from '../sources/gdelt';
import type { SearchTask } from '../sources/types';
import { backfillWindowDays, planWindows } from '../sources/windows';
import type { PipelineState } from './state';

const DAY_MS = 86_400_000;

/** Daily window: since the last successful run, at least 24 h, at most 7 days. */
export function dailyWindow(lastTo: Date | null, now = new Date()): { from: Date; to: Date } {
  const minFrom = new Date(now.getTime() - 7 * DAY_MS);
  const maxFrom = new Date(now.getTime() - DAY_MS);
  let from = lastTo ?? maxFrom;
  if (from > maxFrom) from = maxFrom;
  if (from < minFrom) from = minFrom;
  return { from, to: now };
}

function searchable(c: Category, settings: Settings) {
  const sources = {
    googleNews: settings.sources.googleNews && c.search.sources.googleNews,
    gdelt: settings.sources.gdelt && c.search.sources.gdelt,
  };
  return c.search.enabled && c.search.queries.length > 0 ? sources : null;
}

export function buildDailyTasks(categories: Category[], settings: Settings, from: Date, to: Date): SearchTask[] {
  const tasks: SearchTask[] = [];
  const gdeltQueries: SearchTask['queries'] = [];
  for (const c of categories) {
    if (!c.active) continue;
    const sources = searchable(c, settings);
    if (!sources) continue;
    for (const q of c.search.queries) {
      const entry = { q: q.q, lang: q.lang, categoryId: c.id, exclude: c.search.exclude };
      if (sources.googleNews) {
        tasks.push({ id: randomId(10), provider: 'gnews', categoryId: c.id, queries: [entry], from: from.toISOString(), to: to.toISOString(), mode: 'when' });
      }
      if (sources.gdelt) gdeltQueries.push(entry);
    }
  }
  if (gdeltQueries.length) {
    tasks.push({ id: randomId(10), provider: 'gdelt', categoryId: null, queries: gdeltQueries, from: from.toISOString(), to: to.toISOString(), mode: 'range' });
  }
  return tasks;
}

export function buildBackfillTasks(category: Category, settings: Settings, months: number, now = new Date()): SearchTask[] {
  const sources = searchable(category, settings);
  if (!sources) return [];
  const from = addMonths(now, -months);
  const windows = planWindows(from, now, backfillWindowDays(months));
  const tasks: SearchTask[] = [];
  const entries = category.search.queries.map((q) => ({ q: q.q, lang: q.lang, categoryId: category.id, exclude: category.search.exclude }));
  if (sources.googleNews) {
    for (const w of windows) {
      for (const entry of entries) {
        tasks.push({ id: randomId(10), provider: 'gnews', categoryId: category.id, queries: [entry], from: w.from.toISOString(), to: w.to.toISOString(), mode: 'range' });
      }
    }
  }
  if (sources.gdelt) {
    // One sequential GDELT task per 14-day window inside GDELT's ~3-month horizon.
    const gdeltFrom = new Date(Math.max(from.getTime(), addDays(now, -GDELT_MAX_LOOKBACK_DAYS).getTime()));
    for (const w of planWindows(gdeltFrom, now, 14)) {
      tasks.push({ id: randomId(10), provider: 'gdelt', categoryId: category.id, queries: entries, from: w.from.toISOString(), to: w.to.toISOString(), mode: 'range' });
    }
  }
  return tasks;
}

export async function startDaily(trigger: 'schedule' | 'manual'): Promise<PipelineState> {
  const [categories, settings, last] = await Promise.all([listCategories(), getSettings(), lastSuccessfulDailyRun()]);
  const window = dailyWindow(last ? new Date(last.window.to) : null);
  const runId = timeId();
  const tasks = buildDailyTasks(categories, settings, window.from, window.to);
  await createRun({
    id: runId,
    type: 'daily',
    categoryId: null,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    startedAt: new Date().toISOString(),
    trigger,
  });
  return { runId, runType: 'daily', categoryId: null, tasks };
}

export async function startBackfill(categoryId: string, months: number): Promise<PipelineState> {
  const [category, settings] = await Promise.all([getCategory(categoryId), getSettings()]);
  if (!category) throw new Error(`Category ${categoryId} not found`);
  const runId = timeId();
  const now = new Date();
  const tasks = buildBackfillTasks(category, settings, months, now);
  await createRun({
    id: runId,
    type: 'backfill',
    categoryId,
    window: { from: addMonths(now, -months).toISOString(), to: now.toISOString() },
    startedAt: now.toISOString(),
    trigger: 'category',
  });
  await updateCategory(categoryId, (c) => ({
    ...c,
    backfill: { ...c.backfill, months, status: 'running', runId, startedAt: now.toISOString(), completedAt: null, error: null },
  }));
  return { runId, runType: 'backfill', categoryId, tasks };
}
