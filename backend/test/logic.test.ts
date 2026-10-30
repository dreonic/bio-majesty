import { dailyRunStart, dateInZone, DEFAULT_SETTINGS, type Article, type Digest } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { reviewChange } from '../src/handlers/api/news';
import { decideAction, image } from '../src/handlers/indexer';
import { parseQuery } from '../src/lib/http';
import { createRouter } from '../src/lib/router';
import { dailySchedule } from '../src/lib/schedules';
import { asProfileId } from '../src/repo/keys';
import { localDate, parseDateInput } from '../src/lib/time';
import { isPrivateAddress } from '../src/lib/ssrf';
import { escapeHtml, formatDigestMessage } from '../src/notify/telegram';
import { mergeSettings } from '../src/repo/settings';
import { lastSession, planRange, toWeekly } from '../src/stock';
import { rollup } from '../src/stock/eodhd';
import { dailyTime, priceDecimals } from '../src/stock/provider';
import { deriveSession, refreshPlan } from '../src/stock/session';
import { chunkText } from '../src/vectors/chunk';
import { buildFilter } from '../src/vectors/store';

function article(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    url: 'https://kontan.co.id/a',
    sourceUrl: null,
    title: 'Acme',
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

  it("reads only profiles' article items from the stream, with their profile", () => {
    const raw = (pk: string, sk: string) => ({ PK: { S: pk }, SK: { S: sk }, id: { S: 'a1' }, status: { S: 'APPROVED' } });
    expect(image(raw('PROFILE#p1', 'ART#a1'))).toMatchObject({ profileId: 'p1', article: { id: 'a1', status: 'APPROVED' } });
    expect(image(raw('PROFILE#p1', 'SETTINGS'))).toBeNull();
    expect(image(raw('USER#u1', 'ART#a1'))).toBeNull();
    expect(image(raw('ART#a1', 'META'))).toBeNull();
  });
});

describe('vector filters', () => {
  it('always filters by owner, then by date, category and sentiment', () => {
    expect(buildFilter({ owner: 'u1' })).toEqual({ owner: { $eq: 'u1' } });
    expect(buildFilter({ owner: 'u1', sentiments: ['negative'] })).toEqual({
      $and: [{ owner: { $eq: 'u1' } }, { sentiment: { $in: ['negative'] } }],
    });
    expect(
      buildFilter({ owner: 'u1', from: new Date('2026-01-01T00:00:00Z'), categoryIds: ['a', 'b'] }),
    ).toEqual({
      $and: [
        { owner: { $eq: 'u1' } },
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

  it("reads news dates on the deployment's calendar", () => {
    vi.stubEnv('TIME_ZONE', 'Asia/Singapore');
    expect(localDate(new Date('2026-10-13T16:30:00Z'))).toBe('2026-10-14');
    expect(parseDateInput('2026-10-14').toISOString()).toBe('2026-10-13T16:00:00.000Z');
    expect(parseDateInput('2026-10-14', true).toISOString()).toBe('2026-10-14T15:59:59.999Z');
    expect(parseDateInput('2026-10-14T03:00:00Z').toISOString()).toBe('2026-10-14T03:00:00.000Z');
  });

  it("reads trading dates on the asset's own exchange clock", () => {
    vi.stubEnv('TIME_ZONE', 'Asia/Singapore');
    const tradingDay = parseDateInput('2026-10-14', false, 'Asia/Jakarta');
    expect(tradingDay.toISOString()).toBe('2026-10-13T17:00:00.000Z');
    expect(dateInZone('Asia/Jakarta', tradingDay)).toBe('2026-10-14');
    // Why the stock routes pass the asset's zone: a Singapore midnight is the previous Jakarta day.
    expect(dateInZone('Asia/Jakarta', parseDateInput('2026-10-14'))).toBe('2026-10-13');
  });
});

describe('stock helpers', () => {
  const utcDay = (time: number) => new Date(time * 1000).toISOString();

  it("normalizes daily bars to the asset's trading date", () => {
    // 2026-10-13 02:00 UTC = 09:00 WIB on the 13th
    expect(utcDay(dailyTime(new Date('2026-10-13T02:00:00Z'), 'Asia/Jakarta'))).toBe('2026-10-13T00:00:00.000Z');
    // 2026-10-13 18:00 UTC = 01:00 WIB on the 14th
    expect(utcDay(dailyTime(new Date('2026-10-13T18:00:00Z'), 'Asia/Jakarta'))).toBe('2026-10-14T00:00:00.000Z');
    // ...but still the 13th in New York (14:00 EDT), and for a UTC-dated crypto bar.
    expect(utcDay(dailyTime(new Date('2026-10-13T18:00:00Z'), 'America/New_York'))).toBe('2026-10-13T00:00:00.000Z');
    expect(utcDay(dailyTime(new Date('2026-10-13T00:00:00Z'), 'UTC'))).toBe('2026-10-13T00:00:00.000Z');
  });

  it('plans ranges', () => {
    const now = new Date('2026-10-21T00:00:00Z');
    const listed = new Date('2016-12-09T00:00:00Z');
    expect(planRange('1D', now, listed).source).toBe('intraday');
    expect(planRange('1Y', now, listed)).toMatchObject({ source: 'daily', interval: '1d' });
    expect(planRange('MAX', now, listed)).toEqual({ source: 'daily', interval: '1wk', from: listed });
  });

  it('shows whole-number prices without decimals and others with the source hint', () => {
    expect(priceDecimals([2870, 2900, 2850], 2)).toBe(0);
    expect(priceDecimals([230.5, 231], 2)).toBe(2);
    expect(priceDecimals([16543.2], 4)).toBe(4);
    expect(priceDecimals([], undefined)).toBe(2);
  });

  it('keeps only the last session for 1D and aggregates weeks', () => {
    const t = (iso: string) => Date.parse(iso) / 1000;
    const c = (time: number, close: number) => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 10 });
    const intraday = [c(t('2026-10-12T03:00:00Z'), 1), c(t('2026-10-13T03:00:00Z'), 2), c(t('2026-10-13T04:00:00Z'), 3)];
    expect(lastSession(intraday, 'Asia/Jakarta').map((x) => x.close)).toEqual([2, 3]);
    // A New York session runs past UTC midnight: 19:30 EDT on the 12th is still the 12th there.
    const ny = [c(t('2026-10-12T19:30:00Z'), 1), c(t('2026-10-13T19:30:00Z'), 2), c(t('2026-10-13T23:45:00Z'), 3)];
    expect(lastSession(ny, 'America/New_York').map((x) => x.close)).toEqual([2, 3]);
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

describe('trading sessions', () => {
  // Regular periods Yahoo reported on 2026-10-21 (UTC), as in the asset probe.
  const period = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

  it('turns a reported session into a daily pattern on the exchange clock', () => {
    expect(deriveSession(period('2026-10-21T02:00:00Z', '2026-10-21T09:15:00Z'), 'Asia/Jakarta', 'EQUITY')).toEqual({ start: '09:00', end: '16:15', days: 'weekdays' });
    expect(deriveSession(period('2026-10-20T13:30:00Z', '2026-10-20T20:00:00Z'), 'America/New_York', 'EQUITY')).toEqual({ start: '09:30', end: '16:00', days: 'weekdays' });
    expect(deriveSession(period('2026-10-21T00:00:00Z', '2026-10-21T23:59:00Z'), 'UTC', 'CRYPTOCURRENCY')).toEqual({ start: '00:00', end: '23:59', days: 'daily' });
    expect(deriveSession(period('2026-10-20T23:00:00Z', '2026-10-21T22:59:00Z'), 'Europe/London', 'CURRENCY')).toEqual({ start: '00:00', end: '23:59', days: 'weekdays' });
  });

  const idx = { source: 'yahoo' as const, timeZone: 'Asia/Jakarta', session: { start: '09:00', end: '16:15', days: 'weekdays' as const }, intradayInterval: '15m' };
  const at = (iso: string) => new Date(iso);

  it('refreshes intraday bars during the session and just after the close', () => {
    expect(refreshPlan(idx, '2026-10-20', at('2026-10-21T01:45:00Z')).intraday).toBe(false); // 08:45 WIB
    expect(refreshPlan(idx, '2026-10-20', at('2026-10-21T05:00:00Z')).intraday).toBe(true); // 12:00 WIB
    expect(refreshPlan(idx, '2026-10-20', at('2026-10-21T09:30:00Z')).intraday).toBe(true); // 16:30 WIB, last bar
    expect(refreshPlan(idx, '2026-10-20', at('2026-10-21T09:45:00Z')).intraday).toBe(false);
    expect(refreshPlan(idx, '2026-10-23', at('2026-10-24T05:00:00Z')).intraday).toBe(false); // Saturday
    expect(refreshPlan({ ...idx, intradayInterval: null }, '2026-10-20', at('2026-10-21T05:00:00Z')).intraday).toBe(false); // daily-only fund
  });

  it('runs the end-of-day refresh once per trading date, an hour after the close', () => {
    expect(refreshPlan(idx, '2026-10-20', at('2026-10-21T09:45:00Z')).eodFor).toBeNull(); // 16:45: too early
    expect(refreshPlan(idx, '2026-10-20', at('2026-10-21T10:15:00Z')).eodFor).toBe('2026-10-21'); // 17:15
    expect(refreshPlan(idx, '2026-10-21', at('2026-10-21T10:30:00Z')).eodFor).toBeNull(); // done
    // Monday morning, before the session: Friday's pass if it was missed.
    expect(refreshPlan(idx, '2026-10-22', at('2026-10-26T01:00:00Z')).eodFor).toBe('2026-10-23');
    expect(refreshPlan(idx, '2026-10-23', at('2026-10-26T01:00:00Z')).eodFor).toBeNull();
  });

  it("waits for the source to settle the day: EODHD's bars are final 2-3 hours after the close", () => {
    const eodhd = { ...idx, source: 'eodhd' as const };
    expect(refreshPlan(eodhd, '2026-10-20', at('2026-10-21T10:15:00Z')).eodFor).toBeNull(); // 17:15 WIB: Yahoo would be due
    expect(refreshPlan(eodhd, '2026-10-20', at('2026-10-21T12:15:00Z')).eodFor).toBe('2026-10-21'); // 19:15 WIB
    // Still followed during the session (through its quote).
    expect(refreshPlan(eodhd, '2026-10-20', at('2026-10-21T05:00:00Z')).intraday).toBe(true);
  });

  it('treats crypto as a 24/7 session whose day closes at midnight', () => {
    const btc = { source: 'yahoo' as const, timeZone: 'UTC', session: { start: '00:00', end: '23:59', days: 'daily' as const }, intradayInterval: '15m' };
    const sunday = at('2026-10-25T12:00:00Z');
    expect(refreshPlan(btc, '2026-10-24', sunday)).toEqual({ intraday: true, eodFor: null });
    expect(refreshPlan(btc, '2026-10-23', sunday).eodFor).toBe('2026-10-24');
  });
});

describe('telegram formatting', () => {
  const digest: Digest = {
    id: '2026-10-14',
    runId: 'r',
    runType: 'daily',
    title: '2 new <items>',
    summary: 'Summary',
    highlights: [{ articleId: 'a', title: 'Laba naik', sentiment: 'positive', why: 'Good' }],
    overall: { sentiment: 'positive', reason: 'Results <beat> the forecast' },
    counts: { total: 2, positive: 1, negative: 0, neutral: 0, undecided: 1 },
    createdAt: '2026-10-14T00:00:00Z',
  };

  it('shows the summary, overall sentiment and counts, without the highlights', () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;');
    const text = formatDigestMessage(digest);
    expect(text).toContain('<b>2 new &lt;items&gt;</b>');
    expect(text).toContain('Summary');
    expect(text).toContain('Overall: 🟢 <b>Positive</b> — Results &lt;beat&gt; the forecast');
    expect(text).toContain('📰 2 new items to review (1 positive · 0 negative · 0 neutral · 1 undecided)');
    expect(text).not.toContain('Laba naik');
  });

  it('leaves out the overall line when the digest model failed', () => {
    const text = formatDigestMessage({ ...digest, overall: null, counts: { ...digest.counts, total: 1 } });
    expect(text).not.toContain('Overall');
    expect(text).toContain('📰 1 new item to review');
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

  it('moves an older run time to its quarter hour', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { schedule: { dailyTime: '07:40' } } as never).schedule.dailyTime).toBe('07:30');
  });

  it("schedules a profile's daily run a fixed few minutes after its time, on the dashboard's clock", () => {
    vi.stubEnv('DAILY_SCHEDULE_GROUP', 'news-test-daily-runs');
    vi.stubEnv('DAILY_STATE_MACHINE_ARN', 'arn:aws:states:ap-southeast-1:111122223333:stateMachine:Daily');
    vi.stubEnv('SCHEDULER_ROLE_ARN', 'arn:aws:iam::111122223333:role/scheduler');
    vi.stubEnv('TIME_ZONE', 'Asia/Singapore');
    const id = asProfileId('k3x9q2m8w1aa');
    const start = dailyRunStart('06:45', id);
    const [hour, minute] = start.split(':').map(Number);
    expect(start >= '06:45' && start <= '06:59').toBe(true);
    const schedule = dailySchedule(id, { enabled: true, dailyTime: '06:45' });
    expect(schedule).toMatchObject({
      Name: id,
      GroupName: 'news-test-daily-runs',
      ScheduleExpression: `cron(${minute} ${hour} * * ? *)`,
      ScheduleExpressionTimezone: 'Asia/Singapore',
      State: 'ENABLED',
      Target: { Arn: 'arn:aws:states:ap-southeast-1:111122223333:stateMachine:Daily', RoleArn: 'arn:aws:iam::111122223333:role/scheduler' },
    });
    expect(JSON.parse(schedule.Target!.Input!)).toEqual({ mode: 'daily', trigger: 'schedule', profileId: id });
    expect(dailySchedule(id, { enabled: false, dailyTime: '06:45' }).State).toBe('DISABLED');
    vi.unstubAllEnvs();
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
