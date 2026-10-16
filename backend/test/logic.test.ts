import { DEFAULT_SETTINGS, MARKET_TIME_ZONE, type Article, type Digest } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { reviewChange } from '../src/handlers/api/news';
import { decideAction } from '../src/handlers/indexer';
import { dailyCron } from '../src/lib/aws';
import { parseQuery } from '../src/lib/http';
import { createRouter } from '../src/lib/router';
import { jakartaDate, localDate, parseDateInput } from '../src/lib/time';
import { isPrivateAddress } from '../src/lib/ssrf';
import { escapeHtml, formatDigestMessage } from '../src/notify/telegram';
import { mergeSettings } from '../src/repo/settings';
import { lastSession, planRange, toWeekly } from '../src/stock';
import { rollup } from '../src/stock/eodhd';
import { dailyTime } from '../src/stock/provider';
import { chunkText } from '../src/vectors/chunk';
import { buildFilter } from '../src/vectors/store';

function article(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    url: 'https://kontan.co.id/a',
    sourceUrl: null,
    title: 'Prodia',
    sourceName: 'Kontan',
    sourceDomain: 'kontan.co.id',
    publishedAt: '2026-10-13T00:00:00Z',
    lang: 'id',
    snippet: null,
    textStatus: 'ok',
    status: 'PENDING',
    suggestion: { categoryIds: ['c1'], sentiment: 'positive', rationale: 'r', confidence: 0.8, relevance: 0.9, summary: 's', model: 'm' },
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

describe('review transitions', () => {
  const known = new Set(['c1', 'c2']);

  it('approve uses the request values, falling back to the suggestion', () => {
    expect(reviewChange(article(), { action: 'approve' }, known)).toEqual({
      status: 'APPROVED',
      final: { categoryIds: ['c1'], sentiment: 'positive' },
    });
    expect(reviewChange(article(), { action: 'approve', categoryIds: ['c2', 'bogus'], sentiment: 'negative' }, known)).toEqual({
      status: 'APPROVED',
      final: { categoryIds: ['c2'], sentiment: 'negative' },
    });
  });

  it('only restores filtered/skipped items and only un-saves saved ones', () => {
    expect(reviewChange(article({ status: 'FILTERED' }), { action: 'restore' }, known)).toEqual({ status: 'PENDING' });
    expect(() => reviewChange(article({ status: 'APPROVED' }), { action: 'restore' }, known)).toThrow();
    expect(() => reviewChange(article(), { action: 'unsave' }, known)).toThrow();
    expect(reviewChange(article({ status: 'APPROVED' }), { action: 'unsave' }, known)).toEqual({ status: 'PENDING' });
  });
});

describe('indexer decisions', () => {
  const approved = article({ status: 'APPROVED', final: { categoryIds: ['c1'], sentiment: 'positive' } });
  it('indexes newly approved items and removes un-approved ones', () => {
    expect(decideAction(article(), approved)).toBe('index');
    expect(decideAction(approved, article({ status: 'REJECTED' }))).toBe('delete');
    expect(decideAction(approved, null)).toBe('delete');
  });
  it('re-indexes on tag edits but ignores indexedAt-only updates (no loop)', () => {
    expect(decideAction(approved, { ...approved, final: { categoryIds: ['c1'], sentiment: 'negative' } })).toBe('index');
    expect(decideAction(approved, { ...approved, indexedAt: '2026-10-14T00:00:00Z' })).toBe('none');
    expect(decideAction(article(), article({ status: 'FILTERED' }))).toBe('none');
  });
});

describe('vector filters', () => {
  it('builds S3 Vectors metadata filters', () => {
    expect(buildFilter({})).toBeUndefined();
    expect(buildFilter({ sentiments: ['negative'] })).toEqual({ sentiment: { $in: ['negative'] } });
    expect(
      buildFilter({ from: new Date('2026-01-01T00:00:00Z'), categoryIds: ['a', 'b'] }),
    ).toEqual({
      $and: [
        { publishedAt: { $gte: 1767225600 } },
        { $or: [{ categoryIds: { $eq: 'a' } }, { categoryIds: { $eq: 'b' } }] },
      ],
    });
  });
});

describe('chunking', () => {
  it('keeps short text whole and splits long text with overlap', () => {
    expect(chunkText('short')).toEqual(['short']);
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'kata '.repeat(60)}`).join('\n\n');
    const chunks = chunkText(paragraphs, 1000, 100);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 1200)).toBe(true);
  });
});

describe('dates', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads news dates on the exec's calendar", () => {
    vi.stubEnv('TIME_ZONE', 'Asia/Singapore');
    expect(localDate(new Date('2026-10-13T16:30:00Z'))).toBe('2026-10-14');
    expect(parseDateInput('2026-10-14').toISOString()).toBe('2026-10-13T16:00:00.000Z');
    expect(parseDateInput('2026-10-14', true).toISOString()).toBe('2026-10-14T15:59:59.999Z');
    expect(parseDateInput('2026-10-14T03:00:00Z').toISOString()).toBe('2026-10-14T03:00:00.000Z');
  });

  it('keeps trading dates on Jakarta days', () => {
    vi.stubEnv('TIME_ZONE', 'Asia/Singapore');
    const tradingDay = parseDateInput('2026-10-14', false, MARKET_TIME_ZONE);
    expect(tradingDay.toISOString()).toBe('2026-10-13T17:00:00.000Z');
    expect(jakartaDate(tradingDay)).toBe('2026-10-14');
    // Why the stock routes pass MARKET_TIME_ZONE: a Singapore midnight is the previous Jakarta day.
    expect(jakartaDate(parseDateInput('2026-10-14'))).toBe('2026-10-13');
  });
});

describe('stock helpers', () => {
  it('normalizes daily bars to the Jakarta trading date', () => {
    // 2026-10-13 02:00 UTC = 09:00 WIB on the 13th
    expect(new Date(dailyTime(new Date('2026-10-13T02:00:00Z')) * 1000).toISOString()).toBe('2026-10-13T00:00:00.000Z');
    // 2026-10-13 18:00 UTC = 01:00 WIB on the 14th
    expect(new Date(dailyTime(new Date('2026-10-13T18:00:00Z')) * 1000).toISOString()).toBe('2026-10-14T00:00:00.000Z');
  });

  it('plans ranges', () => {
    expect(planRange('1D').source).toBe('intraday');
    expect(planRange('1Y')).toMatchObject({ source: 'daily', interval: '1d' });
    expect(planRange('MAX').interval).toBe('1wk');
  });

  it('keeps only the last session for 1D and aggregates weeks', () => {
    const t = (iso: string) => Date.parse(iso) / 1000;
    const c = (time: number, close: number) => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 10 });
    const intraday = [c(t('2026-10-12T03:00:00Z'), 1), c(t('2026-10-13T03:00:00Z'), 2), c(t('2026-10-13T04:00:00Z'), 3)];
    expect(lastSession(intraday).map((x) => x.close)).toEqual([2, 3]);
    const daily = [c(t('2026-10-12T00:00:00Z'), 10), c(t('2026-10-13T00:00:00Z'), 12), c(t('2026-10-19T00:00:00Z'), 11)];
    const weekly = toWeekly(daily);
    expect(weekly).toHaveLength(2);
    expect(weekly[0]).toMatchObject({ open: 10, close: 12, high: 13, low: 9, volume: 20 });
  });

  it('rolls 5-minute bars into 15-minute bars', () => {
    const bars = [0, 300, 600, 900].map((s, i) => ({ time: 1_760_000_100 + s, open: i, high: i + 1, low: i - 1, close: i, volume: 1 }));
    const out = rollup(bars, 900);
    expect(out.reduce((s, b) => s + b.volume, 0)).toBe(4);
  });
});

describe('telegram formatting', () => {
  it('escapes HTML and summarizes counts', () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;');
    const digest: Digest = {
      id: '2026-10-14',
      runId: 'r',
      runType: 'daily',
      title: '2 new <items>',
      summary: 'Summary',
      highlights: [{ articleId: 'a', title: 'Laba naik', sentiment: 'positive', why: 'Good' }],
      counts: { total: 2, positive: 1, negative: 0, neutral: 0, undecided: 1 },
      createdAt: '2026-10-14T00:00:00Z',
    };
    const text = formatDigestMessage(digest);
    expect(text).toContain('<b>2 new &lt;items&gt;</b>');
    expect(text).toContain('2 to review · 1 positive · 0 negative · 0 neutral · 1 undecided');
  });
});

describe('ssrf guard', () => {
  it('flags private, loopback, link-local and metadata addresses', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('settings and schedule', () => {
  it('merges partial updates without dropping other tasks', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, {
      models: { tagging: { ...DEFAULT_SETTINGS.models.tagging, model: 'anthropic:claude-haiku-5-5' } },
      schedule: { dailyTime: '07:30' },
    });
    expect(next.models.tagging.model).toBe('anthropic:claude-haiku-5-5');
    expect(next.models.chat.model).toBe(DEFAULT_SETTINGS.models.chat.model);
    expect(next.schedule).toEqual({ enabled: true, dailyTime: '07:30' });
  });

  it('falls back to defaults when stored data is invalid', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { schedule: { dailyTime: '25:99' } } as never);
    expect(next.schedule.dailyTime).toBe('06:00');
  });

  it('builds EventBridge Scheduler cron expressions', () => {
    expect(dailyCron('06:00')).toBe('cron(0 6 * * ? *)');
    expect(dailyCron('17:45')).toBe('cron(45 17 * * ? *)');
  });
});

describe('http helpers', () => {
  const event = (q: Record<string, string>, multi: Record<string, string[]> = {}) =>
    ({ queryStringParameters: q, multiValueQueryStringParameters: multi }) as unknown as APIGatewayProxyEvent;

  it('parses comma-separated and repeated array parameters', () => {
    const schema = z.object({ categories: z.array(z.string()).optional() });
    expect(parseQuery(event({ categories: 'a,b' }), schema, ['categories'])).toEqual({ categories: ['a', 'b'] });
    expect(parseQuery(event({ categories: 'b' }, { categories: ['a', 'b'] }), schema, ['categories'])).toEqual({ categories: ['a', 'b'] });
    expect(parseQuery(event({}), schema, ['categories'])).toEqual({});
  });

  const signedIn = (groups?: string) => ({ authorizer: { claims: { sub: 'u1', ...(groups !== undefined && { 'cognito:groups': groups }) } } });

  it('routes by method + resource and answers preflight', async () => {
    const router = createRouter({ 'GET /ping': async () => ({ statusCode: 200, body: 'pong' }) });
    const base = { headers: {}, resource: '/ping', requestContext: signedIn('dashboard-users') };
    expect((await router({ ...base, httpMethod: 'GET' } as unknown as APIGatewayProxyEvent)).body).toBe('pong');
    expect((await router({ ...base, httpMethod: 'OPTIONS' } as unknown as APIGatewayProxyEvent)).statusCode).toBe(204);
    expect((await router({ ...base, httpMethod: 'POST' } as unknown as APIGatewayProxyEvent)).statusCode).toBe(404);
  });

  it('lets only members of the dashboard group in', async () => {
    const router = createRouter({ 'GET /ping': async () => ({ statusCode: 200, body: 'pong' }) });
    const call = (requestContext: unknown) =>
      router({ headers: {}, resource: '/ping', httpMethod: 'GET', requestContext } as unknown as APIGatewayProxyEvent);
    const denied = await call(signedIn());
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body)).toMatchObject({ error: 'forbidden' });
    expect((await call(signedIn('other-team'))).statusCode).toBe(403);
    expect((await call({})).statusCode).toBe(403);
    // API Gateway passes several groups as one string.
    expect((await call(signedIn('[admins dashboard-users]'))).statusCode).toBe(200);
    expect((await call(signedIn('admins,dashboard-users'))).statusCode).toBe(200);
  });
});
