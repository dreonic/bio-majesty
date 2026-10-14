import { describe, expect, it } from 'vitest';
import {
  CATEGORY_COLORS,
  CategoryInputSchema,
  DEFAULT_SETTINGS,
  SettingsSchema,
  categoryColorFor,
  detectVolumeAnomalies,
  effectiveRationale,
  effectiveSummary,
  effectiveTags,
  parseModelRef,
  type Article,
  type Candle,
} from '../src';

describe('settings', () => {
  it('ships valid defaults (opus 5.5, context off, volume alerts on)', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.models.tagging.model).toBe('anthropic:claude-opus-5-5');
    expect(DEFAULT_SETTINGS.learning.useFeedbackContext).toBe(false);
    expect(DEFAULT_SETTINGS.stock).toMatchObject({ symbol: 'PRDA.JK', volumeAlerts: true, volumeRatio: 2.5 });
  });

  it('parses model references', () => {
    expect(parseModelRef('openrouter:deepseek/deepseek-chat')).toEqual({ provider: 'openrouter', modelId: 'deepseek/deepseek-chat' });
    expect(parseModelRef('no-provider')).toBeNull();
  });
});

describe('categories', () => {
  it('fills defaults for a minimal category', () => {
    const c = CategoryInputSchema.parse({ name: 'Proline' });
    expect(c).toMatchObject({ description: '', backfillMonths: 6, search: { enabled: true, queries: [], sources: { googleNews: true, gdelt: true } } });
  });

  it('assigns the 8 validated colors in order, then a neutral overflow', () => {
    expect(categoryColorFor(0)).toBe(CATEGORY_COLORS[0]);
    expect(categoryColorFor(7)).toBe(CATEGORY_COLORS[7]);
    expect(categoryColorFor(8)).toBe('#898781');
  });
});

describe('effective article values', () => {
  const base = {
    snippet: null,
    suggestion: { categoryIds: ['a'], sentiment: 'negative', rationale: 'AI reason', confidence: 1, relevance: 1, summary: 'AI summary', model: 'm' },
    final: null,
  } as unknown as Article;

  it('falls back to the AI suggestion until reviewed', () => {
    expect(effectiveTags(base)).toEqual({ categoryIds: ['a'], sentiment: 'negative' });
    expect(effectiveSummary(base)).toBe('AI summary');
  });

  it("prefers the exec's edits", () => {
    const reviewed = { ...base, final: { categoryIds: ['b'], sentiment: 'neutral', summary: 'Exec summary', rationale: 'Exec reason' } } as Article;
    expect(effectiveTags(reviewed).sentiment).toBe('neutral');
    expect(effectiveSummary(reviewed)).toBe('Exec summary');
    expect(effectiveRationale(reviewed)).toBe('Exec reason');
  });
});

describe('detectVolumeAnomalies', () => {
  const day = (i: number, volume: number): Candle => ({ time: Date.UTC(2026, 0, 1) / 1000 + i * 86400, open: 1, high: 1, low: 1, close: 1, volume });

  it('ignores zero-volume days in the baseline and honours the threshold', () => {
    const daily = [...Array.from({ length: 15 }, (_, i) => day(i, i === 3 ? 0 : 100)), day(15, 260), day(16, 240)];
    const found = detectVolumeAnomalies(daily, { minRatio: 2.5 });
    expect(found.map((a) => a.date)).toEqual(['2026-01-16']);
    expect(found[0]!.averageVolume).toBe(100);
  });
});
