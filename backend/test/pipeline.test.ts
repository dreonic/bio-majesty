import { DEFAULT_SETTINGS, type Category } from '@bio-majesty/shared';
import { describe, expect, it } from 'vitest';
import { mergeCandidates } from '../src/pipeline/collect';
import { buildBackfillTasks, buildDailyTasks, dailyWindow } from '../src/pipeline/start';
import type { RawCandidate } from '../src/sources/types';

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat1',
    name: 'Prodia Widyahusada',
    description: '',
    color: '#2563eb',
    search: {
      enabled: true,
      queries: [
        { q: '"Prodia Widyahusada"', lang: 'id' },
        { q: '"Prodia" laboratory', lang: 'en' },
      ],
      exclude: ['prodia.com'],
      sources: { googleNews: true, gdelt: true },
    },
    backfill: { months: 0, status: 'none', runId: null, startedAt: null, completedAt: null, error: null },
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
    title: 'Prodia membuka laboratorium baru di Surabaya',
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

  it('respects global and per-category source toggles and label-only categories', () => {
    const settings = { ...DEFAULT_SETTINGS, sources: { googleNews: true, gdelt: false } };
    const labelOnly = category({ id: 'cat3', search: { ...category().search, enabled: false } });
    const tasks = buildDailyTasks([category(), labelOnly], settings, from, to);
    expect(tasks.every((t) => t.provider === 'gnews' && t.categoryId === 'cat1')).toBe(true);
  });

  it('plans backfill windows for every query', () => {
    const now = new Date('2026-10-14T00:00:00Z');
    const tasks = buildBackfillTasks(category(), DEFAULT_SETTINGS, 3, now);
    const gnews = tasks.filter((t) => t.provider === 'gnews');
    expect(gnews.length % 2).toBe(0); // 2 queries per window
    expect(gnews.every((t) => t.mode === 'range')).toBe(true);
    expect(tasks.some((t) => t.provider === 'gdelt')).toBe(true);
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
    const merged = mergeCandidates([raw({}), raw({ gnewsId: 'BBB', url: 'https://news.google.com/rss/articles/BBB', title: 'Laba Prodia turun pada kuartal ketiga 2026' })]);
    expect(merged).toHaveLength(2);
  });
});
