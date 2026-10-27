import { detectVolumeAnomalies, type Article, type Candle, type Category, type Feedback } from '@bio-majesty/shared';
import { describe, expect, it } from 'vitest';
import { feedbackExamplesBlock } from '../src/ai/tasks/classify';
import { buildFeedback } from '../src/feedback/build';
import { reviewChange } from '../src/handlers/api/news';
import { decideAction } from '../src/handlers/indexer';
import { formatVolumeAlert } from '../src/notify/telegram';
import { intradayVolumeAnomaly } from '../src/stock/anomalies';

function article(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    url: 'https://kontan.co.id/a',
    sourceUrl: null,
    title: 'Prodia membuka klinik baru',
    sourceName: 'Kontan',
    sourceDomain: 'kontan.co.id',
    publishedAt: '2026-10-13T00:00:00Z',
    lang: 'id',
    snippet: null,
    textStatus: 'ok',
    status: 'PENDING',
    suggestion: {
      categoryIds: ['c1'],
      sentiment: 'positive',
      rationale: 'Expansion should lift volumes.',
      confidence: 0.8,
      relevance: 0.9,
      summary: 'Prodia opens new clinics.',
      model: 'anthropic:claude-opus-5-5',
    },
    final: null,
    filterReason: null,
    origin: { type: 'daily', runId: 'r1', categoryId: 'c1' },
    foundBy: [],
    createdAt: '2026-10-13T00:00:00Z',
    reviewedAt: null,
    indexedAt: null,
    ...overrides,
  };
}

const known = new Set(['c1', 'c2']);

describe('edited summary and rationale', () => {
  it('keeps exec text only when it differs from the AI suggestion', () => {
    const same = reviewChange(article(), { action: 'approve', summary: ' Prodia opens new clinics. ' }, known);
    expect(same.final).toEqual({ categoryIds: ['c1'], sentiment: 'positive' });

    const edited = reviewChange(
      article(),
      { action: 'approve', sentiment: 'neutral', summary: 'Small expansion in two cities.', rationale: 'Too small to matter.' },
      known,
    );
    expect(edited.final).toEqual({
      categoryIds: ['c1'],
      sentiment: 'neutral',
      summary: 'Small expansion in two cities.',
      rationale: 'Too small to matter.',
    });
  });

  it('preserves earlier edits on later tag updates', () => {
    const saved = article({ status: 'APPROVED', final: { categoryIds: ['c1'], sentiment: 'neutral', summary: 'Exec summary' } });
    expect(reviewChange(saved, { action: 'update', categoryIds: ['c1', 'c2'] }, known).final).toEqual({
      categoryIds: ['c1', 'c2'],
      sentiment: 'neutral',
      summary: 'Exec summary',
    });
  });
});

describe('training feedback', () => {
  it('records which fields the exec changed', () => {
    const final = { categoryIds: ['c1', 'c2'], sentiment: 'neutral' as const, rationale: 'Too small to matter.' };
    const f = buildFeedback(article(), 'approved', final, '2026-10-14T00:00:00Z');
    expect(f.changed).toEqual(['categories', 'sentiment', 'rationale']);
    expect(f.exec).toMatchObject({ sentiment: 'neutral', summary: 'Prodia opens new clinics.', rationale: 'Too small to matter.' });
    expect(f.ai?.sentiment).toBe('positive');
  });

  it('records an approval without edits as a confirmation', () => {
    expect(buildFeedback(article(), 'approved', { categoryIds: ['c1'], sentiment: 'positive' }).changed).toEqual([]);
  });

  it('records a skip as a relevance correction', () => {
    const f = buildFeedback(article(), 'rejected', null);
    expect(f.changed).toEqual(['relevance']);
    expect(f.exec).toBeNull();
  });

  it('formats corrections as in-context examples', () => {
    const categories = [{ id: 'c1', name: 'Corporate', description: '' }, { id: 'c2', name: 'Regulation', description: '' }] as Category[];
    const examples: Feedback[] = [
      buildFeedback(article(), 'approved', { categoryIds: ['c1', 'c2'], sentiment: 'neutral', rationale: 'Too small to matter.' }),
      buildFeedback(article({ id: 'a2', title: 'Unrelated AI company news' }), 'rejected', null),
    ];
    const block = feedbackExamplesBlock(examples, categories);
    expect(block).toContain('Suggested: positive; categories: Corporate');
    expect(block).toContain('Reviewer decided: neutral; categories: Corporate, Regulation');
    expect(block).toContain("Reviewer's reasoning: Too small to matter.");
    expect(block).toContain('skipped this article as not useful');
  });
});

describe('indexer', () => {
  it('re-indexes a saved article when its summary is edited', () => {
    const saved = article({ status: 'APPROVED', final: { categoryIds: ['c1'], sentiment: 'positive' } });
    expect(decideAction(saved, { ...saved, final: { ...saved.final!, summary: 'New summary' } })).toBe('index');
  });
});

function days(volumes: number[], start = Date.UTC(2026, 8, 1) / 1000): Candle[] {
  return volumes.map((volume, i) => ({ time: start + i * 86400, open: 100, high: 101, low: 99, close: 100 + i, volume }));
}

describe('volume anomalies', () => {
  it('flags days far above the trailing average', () => {
    const daily = days([...Array(20).fill(1_000_000), 3_200_000, 1_100_000]);
    const found = detectVolumeAnomalies(daily, { minRatio: 2.5 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ date: '2026-09-21', volume: 3_200_000, averageVolume: 1_000_000, ratio: 3.2, source: 'eod' });
    expect(found[0]!.changePercent).toBeCloseTo(((120 - 119) / 119) * 100, 1);
  });

  it('needs enough history before flagging', () => {
    expect(detectVolumeAnomalies(days([1_000_000, 1_000_000, 9_000_000]), { minHistory: 10 })).toEqual([]);
  });

  it('flags heavy intraday volume against prior sessions only', () => {
    const now = new Date('2026-10-14T05:00:00Z'); // 12:00 WIB
    const prior = days(Array(20).fill(1_000_000), Date.UTC(2026, 8, 10) / 1000);
    const quote = { volume: 2_800_000, marketTime: '2026-10-14T04:55:00Z', price: 3100, changePercent: 1.234 };
    expect(intradayVolumeAnomaly(quote, prior, 2.5, 'Asia/Jakarta', now)).toMatchObject({ date: '2026-10-14', ratio: 2.8, source: 'intraday', changePercent: 1.23 });
    expect(intradayVolumeAnomaly({ ...quote, volume: 1_500_000 }, prior, 2.5, 'Asia/Jakarta', now)).toBeNull();
    expect(intradayVolumeAnomaly({ ...quote, marketTime: '2026-10-10T08:00:00Z' }, prior, 2.5, 'Asia/Jakarta', now)).toBeNull();
  });

  it("dates intraday volume on the asset's own calendar", () => {
    // 01:00 UTC on the 14th is still the 13th in New York.
    const now = new Date('2026-10-14T01:00:00Z');
    const prior = days(Array(20).fill(1_000_000), Date.UTC(2026, 8, 10) / 1000);
    const quote = { volume: 2_800_000, marketTime: '2026-10-14T00:30:00Z', price: 230.5, changePercent: 1 };
    expect(intradayVolumeAnomaly(quote, prior, 2.5, 'America/New_York', now)).toMatchObject({ date: '2026-10-13' });
  });

  it('writes a readable Telegram alert', () => {
    const text = formatVolumeAlert({ id: 'yahoo:PRDA.JK', type: 'EQUITY', decimals: 0 }, {
      date: '2026-10-14',
      time: 0,
      volume: 3_200_000,
      averageVolume: 1_000_000,
      ratio: 3.2,
      close: 3150,
      changePercent: 2.5,
      source: 'intraday',
    });
    expect(text).toContain('Unusual PRDA trading volume today');
    expect(text).toContain('3.2M shares traded so far — 3.2× the 20-day average (1M)');
    expect(text).toContain('Price 3,150 (+2.50%)');
  });

  it('words alerts for assets that are not shares, with their decimals', () => {
    const text = formatVolumeAlert({ id: 'yahoo:BTC-USD', type: 'CRYPTOCURRENCY', decimals: 2 }, {
      date: '2026-10-14',
      time: 0,
      volume: 52_000_000_000,
      averageVolume: 20_000_000_000,
      ratio: 2.6,
      close: 67_123.4,
      changePercent: -1.5,
      source: 'eod',
    });
    expect(text).toContain('Unusual BTC-USD trading volume on 2026-10-14');
    expect(text).toContain('52B traded — 2.6×');
    expect(text).toContain('Price 67,123.40 (-1.50%)');
  });
});
