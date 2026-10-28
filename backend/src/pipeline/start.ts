import type { BackfillPeriod, Category, Settings } from '@bio-majesty/shared';
import { randomId, timeId } from '../lib/ids';
import { addDays, periodStart } from '../lib/time';
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

/** GDELT has no editions: each category's query is searched there once, whatever editions it is listed in. */
function onceForGdelt(entries: SearchTask['queries']): SearchTask['queries'] {
  const seen = new Set<string>();
  return entries.filter((e) => !seen.has(`${e.categoryId}\n${e.q}`) && seen.add(`${e.categoryId}\n${e.q}`));
}

export function buildDailyTasks(categories: Category[], settings: Settings, from: Date, to: Date): SearchTask[] {
  const tasks: SearchTask[] = [];
  const gdeltQueries: SearchTask['queries'] = [];
  for (const c of categories) {
    if (!c.active) continue;
    const sources = searchable(c, settings);
    if (!sources) continue;
    for (const q of c.search.queries) {
      const entry = { q: q.q, edition: q.edition, categoryId: c.id, exclude: c.search.exclude };
      if (sources.googleNews) {
        tasks.push({ id: randomId(10), provider: 'gnews', categoryId: c.id, queries: [entry], from: from.toISOString(), to: to.toISOString(), mode: 'when' });
      }
      if (sources.gdelt) gdeltQueries.push(entry);
    }
  }
  if (gdeltQueries.length) {
    tasks.push({ id: randomId(10), provider: 'gdelt', categoryId: null, queries: onceForGdelt(gdeltQueries), from: from.toISOString(), to: to.toISOString(), mode: 'range' });
  }
  return tasks;
}

export function buildBackfillTasks(category: Category, settings: Settings, period: BackfillPeriod, now = new Date()): SearchTask[] {
  const sources = searchable(category, settings);
  if (!sources) return [];
  const from = periodStart(now, period);
  const windows = planWindows(from, now, backfillWindowDays((now.getTime() - from.getTime()) / 86_400_000));
  const tasks: SearchTask[] = [];
  const entries = category.search.queries.map((q) => ({ q: q.q, edition: q.edition, categoryId: category.id, exclude: category.search.exclude }));
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
      tasks.push({ id: randomId(10), provider: 'gdelt', categoryId: category.id, queries: onceForGdelt(entries), from: w.from.toISOString(), to: w.to.toISOString(), mode: 'range' });
    }
  }
  return tasks;
}

/** Start one account's daily run: its categories, sources and window since its last successful run. */
export async function startDaily(sub: string, trigger: 'schedule' | 'manual'): Promise<PipelineState> {
  const [categories, settings, last] = await Promise.all([listCategories(sub), getSettings(sub), lastSuccessfulDailyRun(sub)]);
  const window = dailyWindow(last ? new Date(last.window.to) : null);
  const runId = timeId();
  const tasks = buildDailyTasks(categories, settings, window.from, window.to);
  await createRun(sub, {
    id: runId,
    type: 'daily',
    categoryId: null,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    startedAt: new Date().toISOString(),
    trigger,
  });
  return { sub, runId, runType: 'daily', categoryId: null, tasks };
}

export async function startBackfill(sub: string, categoryId: string, period: BackfillPeriod): Promise<PipelineState> {
  const [category, settings] = await Promise.all([getCategory(sub, categoryId), getSettings(sub)]);
  if (!category) throw new Error(`Category ${categoryId} not found`);
  const runId = timeId();
  const now = new Date();
  const tasks = buildBackfillTasks(category, settings, period, now);
  await createRun(sub, {
    id: runId,
    type: 'backfill',
    categoryId,
    window: { from: periodStart(now, period).toISOString(), to: now.toISOString() },
    startedAt: now.toISOString(),
    trigger: 'category',
  });
  await updateCategory(sub, categoryId, (c) => ({
    ...c,
    backfill: { ...c.backfill, period, status: 'running', runId, startedAt: now.toISOString(), completedAt: null, error: null },
  }));
  return { sub, runId, runType: 'backfill', categoryId, tasks };
}
