import { describe, expect, it } from 'vitest';
import {
  CATEGORY_COLORS,
  claimGroups,
  hasAccess,
  BackfillPeriodSchema,
  CategoryInputSchema,
  formatBackfillPeriod,
  DEFAULT_EDITION,
  DEFAULT_SETTINGS,
  EDITION_IDS,
  EDITIONS,
  SettingsSchema,
  SettingsUpdateSchema,
  AddAssetRequestSchema,
  AssetIdSchema,
  assetId,
  categoryColorFor,
  detectVolumeAnomalies,
  displaySymbol,
  effectiveRationale,
  effectiveSummary,
  effectiveTags,
  intervalLabel,
  parseAssetId,
  parseModelRef,
  quarterHour,
  symbolProblem,
  type Article,
  type Candle,
} from '../src';

describe('settings', () => {
  it('ships valid defaults (opus 5.5, context off, volume alerts on, a blank subject and no assets)', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.models.tagging.model).toBe('anthropic:claude-haiku-5-5');
    expect(DEFAULT_SETTINGS.learning.useFeedbackContext).toBe(false);
    expect(DEFAULT_SETTINGS.stock).toEqual({ assets: [], volumeAlerts: true, volumeRatio: 2.5 });
    expect(DEFAULT_SETTINGS.subject).toEqual({ name: '', context: '', sentimentAsset: null });
  });

  it('keeps daily runs on quarter hours', () => {
    expect(quarterHour('06:10')).toBe('06:00');
    expect(quarterHour('23:59')).toBe('23:45');
    expect(quarterHour('nonsense')).toBe('nonsense');
    expect(SettingsUpdateSchema.safeParse({ schedule: { dailyTime: '06:10' } }).success).toBe(false);
    expect(SettingsUpdateSchema.safeParse({ schedule: { dailyTime: '06:15' } }).success).toBe(true);
  });

  it('lets a subject update leave the asset list alone (assets are added via /stock/assets)', () => {
    expect(SettingsUpdateSchema.parse({ subject: { sentimentAsset: null } })).toEqual({ subject: { sentimentAsset: null } });
    expect(SettingsUpdateSchema.parse({ subject: { sentimentAsset: 'Yahoo:acme.jk' } })).toEqual({ subject: { sentimentAsset: 'yahoo:ACME.JK' } });
    expect(SettingsUpdateSchema.parse({ stock: { assets: ['yahoo:AAPL'] } })).toEqual({ stock: {} });
  });

  it('parses model references', () => {
    expect(parseModelRef('openrouter:deepseek/deepseek-chat')).toEqual({ provider: 'openrouter', modelId: 'deepseek/deepseek-chat' });
    expect(parseModelRef('no-provider')).toBeNull();
  });
});

describe('asset symbols and IDs', () => {
  it("checks symbols against each source's format", () => {
    for (const s of ['ACME.JK', 'aapl', '^JKSE', 'USDIDR=X', 'BTC-USD', 'GC=F', 'D05.SI']) expect(symbolProblem('yahoo', s), s).toBeNull();
    for (const s of ['', 'not a symbol', 'A'.repeat(21), '#X']) expect(symbolProblem('yahoo', s), s).toMatch(/^Not in Yahoo Finance's symbol format/);
    for (const s of ['ACME.JK', 'aapl.us', 'BRK-B.US', 'GSPC.INDX', 'EURUSD.FOREX', 'BTC-USD.CC']) expect(symbolProblem('eodhd', s), s).toBeNull();
    // EODHD symbols need their exchange code.
    for (const s of ['ACME', 'AAPL', '^JKSE', 'ACME.JK.']) expect(symbolProblem('eodhd', s), s).toMatch(/^Not in EODHD's symbol format/);
  });

  it('names assets by source and symbol, normalized', () => {
    expect(assetId('yahoo', ' acme.jk ')).toBe('yahoo:ACME.JK');
    expect(parseAssetId('eodhd:aapl.us')).toEqual({ source: 'eodhd', symbol: 'AAPL.US' });
    expect(AssetIdSchema.parse(' Yahoo:btc-usd ')).toBe('yahoo:BTC-USD');
    for (const s of ['ACME.JK', 'eodhd:ACME', 'google:ACME.JK', 'yahoo:', ':ACME.JK']) expect(AssetIdSchema.safeParse(s).success, s).toBe(false);
  });

  it('validates new assets against their source', () => {
    expect(AddAssetRequestSchema.parse({ source: 'eodhd', symbol: ' acme.jk' })).toEqual({ source: 'eodhd', symbol: 'ACME.JK' });
    const bad = AddAssetRequestSchema.safeParse({ source: 'eodhd', symbol: 'ACME' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({ path: ['symbol'] });
    expect(AddAssetRequestSchema.safeParse({ source: 'google', symbol: 'ACME.JK' }).success).toBe(false);
  });

  it('shows tickers without the exchange suffix and names intervals', () => {
    expect(displaySymbol('yahoo:ACME.JK')).toBe('ACME');
    expect(displaySymbol('yahoo:BTC-USD')).toBe('BTC-USD');
    expect(displaySymbol('yahoo:^JKSE')).toBe('^JKSE');
    expect(displaySymbol('eodhd:ACME.JK')).toBe('ACME');
    expect(displaySymbol('eodhd:EURUSD.FOREX')).toBe('EURUSD');
    expect(displaySymbol('ACME.JK')).toBe('ACME.JK');
    expect(intervalLabel('15m')).toBe('15-min');
    expect(intervalLabel('1h')).toBe('1-hour');
    expect(intervalLabel('1d')).toBe('Daily');
  });
});

describe('categories', () => {
  it('fills defaults for a minimal category', () => {
    const c = CategoryInputSchema.parse({ name: 'Acme Digital' });
    expect(c).toMatchObject({ description: '', backfillPeriod: { amount: 6, unit: 'months' }, search: { enabled: true, queries: [], sources: { googleNews: true, gdelt: true } } });
  });

  it('takes a backfill period in days, weeks, months or years, up to about 3 years', () => {
    const ok = (amount: number, unit: string) => BackfillPeriodSchema.safeParse({ amount, unit }).success;
    expect([ok(10, 'days'), ok(1095, 'days'), ok(156, 'weeks'), ok(36, 'months'), ok(3, 'years')]).toEqual([true, true, true, true, true]);
    expect([ok(1096, 'days'), ok(37, 'months'), ok(4, 'years'), ok(0, 'days'), ok(1.5, 'weeks'), ok(2, 'decades')]).toEqual([false, false, false, false, false, false]);
    expect(CategoryInputSchema.parse({ name: 'Acme', backfillPeriod: null }).backfillPeriod).toBeNull();
    expect([formatBackfillPeriod({ amount: 1, unit: 'weeks' }), formatBackfillPeriod({ amount: 6, unit: 'months' })]).toEqual(['1 week', '6 months']);
  });

  it('assigns the 8 validated colors in order, then a neutral overflow', () => {
    expect(categoryColorFor(0)).toBe(CATEGORY_COLORS[0]);
    expect(categoryColorFor(7)).toBe(CATEGORY_COLORS[7]);
    expect(categoryColorFor(8)).toBe('#898781');
  });

  it('searches each query in a known Google News edition', () => {
    const search = (queries: object[]) => CategoryInputSchema.safeParse({ name: 'Acme', search: { queries } }).success;
    expect(search([{ q: 'acme', edition: 'ID:id' }, { q: 'acme', edition: 'SG:en' }])).toBe(true);
    expect(search([{ q: 'acme', lang: 'id' }])).toBe(false);
    expect(search([{ q: 'acme', edition: 'SG:zh-Hans' }])).toBe(false);
    for (const id of EDITION_IDS) expect(id).toMatch(/^[A-Z]{2}:[a-z]{2}(-\w+)?$/);
    expect(EDITIONS[DEFAULT_EDITION].lang).toBe('en');
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

describe('dashboard access group', () => {
  it('reads cognito:groups from an ID token or from API Gateway claims', () => {
    expect(claimGroups(['dashboard-users', 'admins'])).toEqual(['dashboard-users', 'admins']);
    expect(claimGroups('dashboard-users')).toEqual(['dashboard-users']);
    expect(claimGroups('[admins dashboard-users]')).toEqual(['admins', 'dashboard-users']);
    expect(claimGroups('admins,dashboard-users')).toEqual(['admins', 'dashboard-users']);
    expect(claimGroups(undefined)).toEqual([]);
    expect(hasAccess(['dashboard-users'])).toBe(true);
    expect(hasAccess('[admins]')).toBe(false);
    expect(hasAccess(undefined)).toBe(false);
  });
});
