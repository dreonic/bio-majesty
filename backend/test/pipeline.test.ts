import { DEFAULT_SETTINGS, type Category } from '@bio-majesty/shared';
import { describe, expect, it } from 'vitest';
import { mergeCandidates } from '../src/pipeline/collect';
import { buildBackfillTasks, buildDailyTasks, dailyWindow } from '../src/pipeline/start';
import type { RawCandidate } from '../src/sources/types';

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat1',
    name: 'Acme Laboratorium',
    description: '',
    color: '#2563eb',
    search: {
      enabled: true,
      queries: [
        { q: '"Acme Laboratorium"', edition: 'ID:id' },
        { q: '"Acme" laboratory', edition: 'ID:en' },
      ],
      exclude: ['acme.example'],
      sources: { googleNews: true, gdelt: true },
    },
    backfill: { period: null, status: 'none', runId: null, startedAt: null, completedAt: null, error: null },
    active: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function raw(overrides: Partial<RawCandidate>): RawCandidate {
  return {
    id: 'x',
    provider: 'gnews',
    query: 'q',
    lang: 'id',
    categoryId: 'cat1',
    title: 'Acme membuka laboratorium baru di Surabaya',
    url: 'https://news.google.com/rss/articles/AAA',
    gnewsId: 'AAA',
    sourceName: 'Kontan',
    sourceDomain: 'kontan.co.id',
    publishedAt: '2026-10-13T00:00:00Z',
    snippet: null,
    ...overrides,
  };
}

describe('dailyWindow', () => {
  const now = new Date('2026-10-14T06:00:00Z');
  it('defaults to the last 24 hours', () => {
    expect(dailyWindow(null, now).from).toEqual(new Date('2026-10-13T06:00:00Z'));
  });
  it('extends back to the last successful run, at most 7 days', () => {
    expect(dailyWindow(new Date('2026-10-11T06:00:00Z'), now).from).toEqual(new Date('2026-10-11T06:00:00Z'));
    expect(dailyWindow(new Date('2026-09-01T00:00:00Z'), now).from).toEqual(new Date('2026-10-07T06:00:00Z'));
  });
});

describe('task planning', () => {
  const from = new Date('2026-10-13T06:00:00Z');
  const to = new Date('2026-10-14T06:00:00Z');

  it('creates one Google News task per query and one shared GDELT task', () => {
    const tasks = buildDailyTasks([category(), category({ id: 'cat2', active: false })], DEFAULT_SETTINGS, from, to);
    expect(tasks.filter((t) => t.provider === 'gnews')).toHaveLength(2);
    const gdelt = tasks.filter((t) => t.provider === 'gdelt');
    expect(gdelt).toHaveLength(1);
    expect(gdelt[0]!.queries).toHaveLength(2);
    expect(tasks.every((t) => t.mode === 'when' || t.provider === 'gdelt')).toBe(true);
  });

  it('adds day-by-day Google News tasks for a longer window, while GDELT searches the exact window', () => {
    const tasks = buildDailyTasks([category()], DEFAULT_SETTINGS, new Date('2026-10-11T06:00:00Z'), to);
    const gnews = tasks.filter((t) => t.provider === 'gnews');
    expect(gnews).toHaveLength(2 * 5); // per query: the last day, then 4 calendar days
    expect(gnews.filter((t) => t.mode === 'when')).toHaveLength(2);
    expect(tasks.find((t) => t.provider === 'gdelt')).toMatchObject({ from: '2026-10-11T06:00:00.000Z', to: to.toISOString(), mode: 'range' });
  });

  it('searches a query once per edition on Google News but only once on GDELT', () => {
    const editions = category({ search: { ...category().search, queries: [{ q: 'acme', edition: 'US:en' }, { q: 'acme', edition: 'GB:en' }, { q: 'acme', edition: 'SG:en' }] } });
    const tasks = buildDailyTasks([editions, category({ id: 'cat2', search: { ...category().search, queries: [{ q: 'acme', edition: 'US:en' }] } })], DEFAULT_SETTINGS, from, to);
    expect(tasks.filter((t) => t.provider === 'gnews').map((t) => t.queries[0]!.edition)).toEqual(['US:en', 'GB:en', 'SG:en', 'US:en']);
    // Once per category: GDELT results are credited to the category that searched them.
    expect(tasks.find((t) => t.provider === 'gdelt')!.queries.map((q) => `${q.categoryId}:${q.q}`)).toEqual(['cat1:acme', 'cat2:acme']);
    const backfill = buildBackfillTasks(editions, DEFAULT_SETTINGS, { amount: 1, unit: 'months' }, new Date('2026-10-14T00:00:00Z'));
    expect(backfill.filter((t) => t.provider === 'gdelt').every((t) => t.queries.length === 1)).toBe(true);
  });

  it('respects global and per-category source toggles and label-only categories', () => {
    const settings = { ...DEFAULT_SETTINGS, sources: { googleNews: true, gdelt: false } };
    const labelOnly = category({ id: 'cat3', search: { ...category().search, enabled: false } });
    const tasks = buildDailyTasks([category(), labelOnly], settings, from, to);
    expect(tasks.every((t) => t.provider === 'gnews' && t.categoryId === 'cat1')).toBe(true);
  });

  it('plans backfill windows for every query', () => {
    const now = new Date('2026-10-14T00:00:00Z');
    const tasks = buildBackfillTasks(category(), DEFAULT_SETTINGS, { amount: 3, unit: 'months' }, now);
    const gnews = tasks.filter((t) => t.provider === 'gnews');
    expect(gnews.length % 2).toBe(0); // 2 queries per window
    expect(gnews.every((t) => t.mode === 'range')).toBe(true);
    expect(tasks.some((t) => t.provider === 'gdelt')).toBe(true);
  });

  it('reaches back by the period in days, weeks, months or years', () => {
    const now = new Date('2026-10-14T00:00:00Z');
    const oldest = (amount: number, unit: 'days' | 'weeks' | 'months' | 'years') => {
      const gnews = buildBackfillTasks(category(), DEFAULT_SETTINGS, { amount, unit }, now).filter((t) => t.provider === 'gnews');
      return { from: gnews.map((t) => t.from).sort()[0], windows: gnews.length / 2 };
    };
    expect(oldest(10, 'days')).toEqual({ from: '2026-10-04T00:00:00.000Z', windows: 2 }); // 7-day windows
    expect(oldest(2, 'weeks')).toEqual({ from: '2026-09-30T00:00:00.000Z', windows: 2 });
    expect(oldest(1, 'years').from).toBe('2025-10-14T00:00:00.000Z');
    expect(oldest(1, 'years').windows).toBe(27); // 14-day windows up to a year
  });
});

describe('mergeCandidates', () => {
  it('merges the same story found by two queries and records both', () => {
    const merged = mergeCandidates([raw({ query: 'q1' }), raw({ query: 'q2', categoryId: 'cat2' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.foundBy.map((f) => f.query)).toEqual(['q1', 'q2']);
    expect(merged[0]!.categoryHints).toEqual(['cat1', 'cat2']);
  });

  it('prefers the publisher URL from GDELT over the Google News link', () => {
    const merged = mergeCandidates([
      raw({}),
      raw({ provider: 'gdelt', url: 'https://kontan.co.id/news/surabaya', gnewsId: null }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.url).toBe('https://kontan.co.id/news/surabaya');
  });

  it('keeps different stories apart', () => {
    const merged = mergeCandidates([raw({}), raw({ gnewsId: 'BBB', url: 'https://news.google.com/rss/articles/BBB', title: 'Laba Acme turun pada kuartal ketiga 2026' })]);
    expect(merged).toHaveLength(2);
  });
});
