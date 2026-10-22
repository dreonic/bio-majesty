import { describe, expect, it } from 'vitest';
import {
  CATEGORY_COLORS,
  claimGroups,
  hasAccess,
  CategoryInputSchema,
  DEFAULT_SETTINGS,
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
  it('ships valid defaults (opus 5.5, context off, volume alerts on, the Prodia profile)', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.models.tagging.model).toBe('anthropic:claude-opus-5-5');
    expect(DEFAULT_SETTINGS.learning.useFeedbackContext).toBe(false);
    expect(DEFAULT_SETTINGS.stock).toEqual({ assets: ['yahoo:PRDA.JK'], volumeAlerts: true, volumeRatio: 2.5 });
    expect(DEFAULT_SETTINGS.profile).toMatchObject({ subject: 'the Prodia group', sentimentAsset: 'yahoo:PRDA.JK' });
  });

  it('keeps daily runs on quarter hours', () => {
    expect(quarterHour('06:10')).toBe('06:00');
    expect(quarterHour('23:59')).toBe('23:45');
    expect(quarterHour('nonsense')).toBe('nonsense');
    expect(SettingsUpdateSchema.safeParse({ schedule: { dailyTime: '06:10' } }).success).toBe(false);
    expect(SettingsUpdateSchema.safeParse({ schedule: { dailyTime: '06:15' } }).success).toBe(true);
  });

  it('lets a profile update leave the asset list alone (assets are added via /stock/assets)', () => {
    expect(SettingsUpdateSchema.parse({ profile: { sentimentAsset: null } })).toEqual({ profile: { sentimentAsset: null } });
    expect(SettingsUpdateSchema.parse({ profile: { sentimentAsset: 'Yahoo:prda.jk' } })).toEqual({ profile: { sentimentAsset: 'yahoo:PRDA.JK' } });
    expect(SettingsUpdateSchema.parse({ stock: { assets: ['yahoo:AAPL'] } })).toEqual({ stock: {} });
  });

  it('parses model references', () => {
    expect(parseModelRef('openrouter:deepseek/deepseek-chat')).toEqual({ provider: 'openrouter', modelId: 'deepseek/deepseek-chat' });
    expect(parseModelRef('no-provider')).toBeNull();
  });
});

describe('asset symbols and IDs', () => {
  it("checks symbols against each source's format", () => {
    for (const s of ['PRDA.JK', 'aapl', '^JKSE', 'USDIDR=X', 'BTC-USD', 'GC=F', 'D05.SI']) expect(symbolProblem('yahoo', s), s).toBeNull();
    for (const s of ['', 'not a symbol', 'A'.repeat(21), '#X']) expect(symbolProblem('yahoo', s), s).toMatch(/^Not in Yahoo Finance's symbol format/);
    for (const s of ['PRDA.JK', 'aapl.us', 'BRK-B.US', 'GSPC.INDX', 'EURUSD.FOREX', 'BTC-USD.CC']) expect(symbolProblem('eodhd', s), s).toBeNull();
    // EODHD symbols need their exchange code.
    for (const s of ['PRDA', 'AAPL', '^JKSE', 'PRDA.JK.']) expect(symbolProblem('eodhd', s), s).toMatch(/^Not in EODHD's symbol format/);
  });

  it('names assets by source and symbol, normalized', () => {
    expect(assetId('yahoo', ' prda.jk ')).toBe('yahoo:PRDA.JK');
    expect(parseAssetId('eodhd:aapl.us')).toEqual({ source: 'eodhd', symbol: 'AAPL.US' });
    expect(AssetIdSchema.parse(' Yahoo:btc-usd ')).toBe('yahoo:BTC-USD');
    for (const s of ['PRDA.JK', 'eodhd:PRDA', 'google:PRDA.JK', 'yahoo:', ':PRDA.JK']) expect(AssetIdSchema.safeParse(s).success, s).toBe(false);
  });

  it('validates new assets against their source', () => {
    expect(AddAssetRequestSchema.parse({ source: 'eodhd', symbol: ' prda.jk' })).toEqual({ source: 'eodhd', symbol: 'PRDA.JK' });
    const bad = AddAssetRequestSchema.safeParse({ source: 'eodhd', symbol: 'PRDA' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({ path: ['symbol'] });
    expect(AddAssetRequestSchema.safeParse({ source: 'google', symbol: 'PRDA.JK' }).success).toBe(false);
  });

  it('shows tickers without the exchange suffix and names intervals', () => {
    expect(displaySymbol('yahoo:PRDA.JK')).toBe('PRDA');
    expect(displaySymbol('yahoo:BTC-USD')).toBe('BTC-USD');
    expect(displaySymbol('yahoo:^JKSE')).toBe('^JKSE');
    expect(displaySymbol('eodhd:PRDA.JK')).toBe('PRDA');
    expect(displaySymbol('eodhd:EURUSD.FOREX')).toBe('EURUSD');
    expect(displaySymbol('PRDA.JK')).toBe('PRDA.JK');
    expect(intervalLabel('15m')).toBe('15-min');
    expect(intervalLabel('1h')).toBe('1-hour');
    expect(intervalLabel('1d')).toBe('Daily');
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
