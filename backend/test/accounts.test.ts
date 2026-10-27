import { GetCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, type StockAsset } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TABLE_NAME = 'test-table';
process.env.DATA_BUCKET = 'test-bucket';

// --- Telegram: one bot, many accounts -------------------------------------------------
const links = new Map<string, { chatId: number | null; chatTitle: string | null }>();
const codes = new Map<string, { sub: string; linkedChatTitle: string | null }>();
let offset = 0;
let pendingUpdates: { update_id: number; message?: { chat: { id: number; type: string; title?: string }; text?: string } }[] = [];
const sent: number[] = [];

vi.mock('../src/repo/telegram', () => ({
  getTelegramLink: async (sub: string) => ({ chatId: null, chatTitle: null, linkedAt: null, ...links.get(sub) }),
  putTelegramLink: async (sub: string, link: { chatId: number | null; chatTitle: string | null }) => void links.set(sub, link),
  getUpdateOffset: async () => offset,
  setUpdateOffset: async (o: number) => void (offset = o),
  putLinkCode: async (code: string, sub: string) => void codes.set(code, { sub, linkedChatTitle: null }),
  getLinkCode: async (code: string) => (codes.has(code) ? { ...codes.get(code)!, expiresAt: 0 } : null),
  markLinkCodeUsed: async (code: string, title: string) => void (codes.get(code)!.linkedChatTitle = title),
}));
vi.mock('../src/storage/s3', () => ({
  getJson: async () => null,
  deleteObjects: async () => undefined,
  s3Keys: { articleText: (sub: string, id: string) => `users/${sub}/articles/${id}.json` },
}));
vi.mock('../src/notify/telegram', async (original) => ({
  ...(await original<typeof import('../src/notify/telegram')>()),
  isTelegramConfigured: async () => true,
  getUpdates: async (from: number) => pendingUpdates.filter((u) => u.update_id >= from),
  sendMessage: async (chatId: number) => void sent.push(chatId),
}));

const telegram = (await import('../src/handlers/api/telegram')).handler;
const news = (await import('../src/handlers/api/news')).handler;
const { buildChatTools, chatInstructions } = await import('../src/ai/chat-agent');
const { sentimentRubric } = await import('../src/ai/prompts');

const as = (sub: string, method: string, resource: string, extra: Partial<APIGatewayProxyEvent> = {}) =>
  ({
    httpMethod: method,
    resource,
    headers: {},
    requestContext: { authorizer: { claims: { sub, 'cognito:groups': 'dashboard-users' } } },
    ...extra,
  }) as unknown as APIGatewayProxyEvent;

describe('Telegram linking with several accounts', () => {
  beforeEach(() => {
    links.clear();
    codes.clear();
    offset = 0;
    sent.length = 0;
    codes.set('code-u1-xxxxxxxx', { sub: 'u1', linkedChatTitle: null });
    codes.set('code-u2-xxxxxxxx', { sub: 'u2', linkedChatTitle: null });
    pendingUpdates = [
      { update_id: 7, message: { chat: { id: 101, type: 'private', title: 'Exec' }, text: '/start code-u1-xxxxxxxx' } },
      { update_id: 8, message: { chat: { id: 202, type: 'private', title: 'Colleague' }, text: '/start code-u2-xxxxxxxx' } },
    ];
  });

  const verify = (sub: string, code: string) =>
    telegram(as(sub, 'POST', '/telegram/link/verify', { body: JSON.stringify({ code }) })).then((r) => JSON.parse(r.body));

  it("links every account whose /start is in the batch, so one account's check can't swallow another's", async () => {
    expect(await verify('u1', 'code-u1-xxxxxxxx')).toEqual({ linked: true, chatTitle: 'Exec' });
    expect(offset).toBe(9); // both messages are consumed by this one check...
    expect(links.get('u2')).toMatchObject({ chatId: 202 }); // ...and the colleague is linked too
    expect(await verify('u2', 'code-u2-xxxxxxxx')).toEqual({ linked: true, chatTitle: 'Colleague' });
    expect(sent.sort()).toEqual([101, 202]);
  });

  it("refuses another account's link code", async () => {
    expect((await telegram(as('u2', 'POST', '/telegram/link/verify', { body: JSON.stringify({ code: 'code-u1-xxxxxxxx' }) }))).statusCode).toBe(400);
  });
});

describe('news is per account', () => {
  const db = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    db.reset();
    // Only u1 owns article a1.
    db.on(GetCommand).callsFake((input: GetCommand['input']) =>
      input.Key?.PK === 'USER#u1' && input.Key?.SK === 'ART#a1' ? { Item: { ...input.Key, id: 'a1', status: 'APPROVED', title: 'Laba naik' } } : {},
    );
    db.on(QueryCommand).resolves({ Items: [] });
  });

  it("can't open another account's article", async () => {
    expect((await news(as('u1', 'GET', '/news/{id}', { pathParameters: { id: 'a1' } }))).statusCode).toBe(200);
    expect((await news(as('u2', 'GET', '/news/{id}', { pathParameters: { id: 'a1' } }))).statusCode).toBe(404);
  });

  it("lists only the caller's news", async () => {
    await news(as('u2', 'GET', '/news', { queryStringParameters: { status: 'APPROVED' } }));
    const queried = db.commandCalls(QueryCommand).map((c) => c.args[0].input.ExpressionAttributeValues?.[':pk']);
    expect(queried).toEqual(['USER#u2#STATUS#APPROVED']);
  });
});

describe('chat over one account', () => {
  const prda: StockAsset = {
    id: 'yahoo:PRDA.JK',
    source: 'yahoo',
    symbol: 'PRDA.JK',
    name: 'PT Prodia Widyahusada Tbk',
    exchange: 'Jakarta',
    type: 'EQUITY',
    currency: 'IDR',
    timeZone: 'Asia/Jakarta',
    session: { start: '09:00', end: '16:15', days: 'weekdays' },
    intradayInterval: '15m',
    decimals: 0,
    hasVolume: true,
    firstTradeDate: null,
    updatedAt: '',
  };

  it("offers prices only for the account's own assets", () => {
    expect(Object.keys(buildChatTools({ sub: 'u1', assets: [] }))).toEqual(['searchNews', 'listNews', 'getArticle']);
    const tools = buildChatTools({ sub: 'u1', assets: [prda] });
    expect(tools).toHaveProperty('getAssetPrices');
    expect(tools.getAssetPrices?.description).toContain('yahoo:PRDA.JK = PRDA (PT Prodia Widyahusada Tbk)');
  });

  it("frames answers with the account's profile and sentiment basis", () => {
    const profile = { subject: 'Acme Labs', context: 'A laboratory chain.', sentimentAsset: prda.id };
    const text = chatInstructions({ profile, asset: prda }, [], [prda]);
    expect(text).toContain('You support a reader who follows Acme Labs.\n\nA laboratory chain.');
    expect(text).toContain('likely effect on the PRDA (PT Prodia Widyahusada Tbk) share price');
  });

  it('falls back to the categories when a new account has no subject yet', () => {
    const text = chatInstructions({ profile: DEFAULT_PROFILE, asset: null }, [], []);
    expect(text).toContain('You support a reader who follows the topics of their news categories.');
    expect(text).toContain('likely effect on the topic each article is about');
  });
});

describe('sentiment rubric', () => {
  it("judges against the profile's asset, or the subject itself without one", () => {
    const profile = { ...DEFAULT_SETTINGS.profile, subject: 'Acme Labs' };
    const price = sentimentRubric(profile, { id: 'yahoo:BTC-USD', name: 'Bitcoin USD', type: 'CRYPTOCURRENCY' });
    expect(price).toContain('relative to the BTC-USD (Bitcoin USD) price — how an investor');
    expect(price).toContain('positive: likely to support the price');
    const subject = sentimentRubric(profile, null);
    expect(subject).toContain('relative to Acme Labs — how a well-informed reader');
    expect(subject).toContain('positive: good news for Acme Labs');
    expect(sentimentRubric(DEFAULT_SETTINGS.profile, null)).toContain('negative: bad news for the topic each article is about');
  });
});
