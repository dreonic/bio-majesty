import { GetCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_SETTINGS, DEFAULT_SUBJECT, type StockAsset } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TABLE_NAME = 'test-table';
process.env.DATA_BUCKET = 'test-bucket';

// --- Telegram: one bot, many accounts, several connections each ------------------------------
type Link = { id: string; chatId: number; topicId: number | null; chatTitle: string; kind: string; linkedAt: string };
const links = new Map<string, Map<string, Link>>();
const codes = new Map<string, { sub: string; kind: 'private' | 'group'; linkedChatTitle: string | null }>();
let offset = 0;
let pendingUpdates: import('../src/notify/telegram').TelegramUpdate[] = [];
const sent: { chatId: number; topicId: number | null; text: string }[] = [];
let failingChat: number | null = null;

vi.mock('../src/repo/telegram', () => ({
  telegramLinkId: (chatId: number, topicId: number | null) => `${chatId}_${topicId ?? 0}`,
  listTelegramLinks: async (sub: string) => [...(links.get(sub)?.values() ?? [])],
  putTelegramLink: async (sub: string, link: Link) => void links.set(sub, (links.get(sub) ?? new Map()).set(link.id, link)),
  deleteTelegramLink: async (sub: string, id: string) => links.get(sub)?.delete(id) ?? false,
  getUpdateOffset: async () => offset,
  setUpdateOffset: async (o: number) => void (offset = o),
  putLinkCode: async (code: string, sub: string, kind: 'private' | 'group') => void codes.set(code, { sub, kind, linkedChatTitle: null }),
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
  getBotUsername: async () => 'news_bot',
  getUpdates: async (from: number) => pendingUpdates.filter((u) => u.update_id >= from),
  sendMessage: async (chatId: number, text: string, opts: { topicId?: number | null } = {}) => {
    if (chatId === failingChat) throw new Error('Telegram sendMessage failed: bot was kicked from the group');
    sent.push({ chatId, topicId: opts.topicId ?? null, text });
  },
}));

const telegram = (await import('../src/handlers/api/telegram')).handler;
const { notifyAccount } = await import('../src/notify/notify');
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
    failingChat = null;
    codes.set('code-u1-xxxxxxxx', { sub: 'u1', kind: 'private', linkedChatTitle: null });
    codes.set('code-u2-xxxxxxxx', { sub: 'u2', kind: 'private', linkedChatTitle: null });
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
    expect([...links.get('u2')!.values()]).toMatchObject([{ chatId: 202 }]); // ...and the colleague is linked too
    expect(await verify('u2', 'code-u2-xxxxxxxx')).toEqual({ linked: true, chatTitle: 'Colleague' });
    expect(sent.map((s) => s.chatId).sort()).toEqual([101, 202]);
  });

  it("refuses another account's link code", async () => {
    expect((await telegram(as('u2', 'POST', '/telegram/link/verify', { body: JSON.stringify({ code: 'code-u1-xxxxxxxx' }) }))).statusCode).toBe(400);
  });

  it('links a topic of a forum supergroup, and replies there', async () => {
    codes.set('code-u1-xxxxxxxx', { sub: 'u1', kind: 'group', linkedChatTitle: null });
    codes.set('code-u2-xxxxxxxx', { sub: 'u2', kind: 'group', linkedChatTitle: null });
    pendingUpdates = [
      // Meant for another bot in the same group: ignored.
      { update_id: 7, message: { chat: { id: -100, type: 'supergroup', title: 'Execs' }, text: '/start@other_bot code-u1-xxxxxxxx' } },
      {
        update_id: 8,
        message: {
          chat: { id: -100, type: 'supergroup', title: 'Execs' },
          text: '/start@News_Bot code-u1-xxxxxxxx',
          message_thread_id: 42,
          is_topic_message: true,
          reply_to_message: { forum_topic_created: { name: 'Acme' } },
        },
      },
      // A plain group (or the General topic): no topic.
      { update_id: 9, message: { chat: { id: -200, type: 'group', title: 'Team' }, text: '/start@news_bot code-u2-xxxxxxxx' } },
    ];
    expect(await verify('u1', 'code-u1-xxxxxxxx')).toEqual({ linked: true, chatTitle: 'Execs › Acme' });
    expect([...links.get('u1')!.values()]).toMatchObject([{ id: '-100_42', chatId: -100, topicId: 42, kind: 'group' }]);
    expect([...links.get('u2')!.values()]).toMatchObject([{ id: '-200_0', chatId: -200, topicId: null, chatTitle: 'Team' }]);
    expect(sent.map(({ chatId, topicId }) => ({ chatId, topicId }))).toEqual([
      { chatId: -100, topicId: 42 },
      { chatId: -200, topicId: null },
    ]);
  });

  it("won't let a private chat take a code meant for a group (Telegram may send /start by itself)", async () => {
    codes.set('code-u1-xxxxxxxx', { sub: 'u1', kind: 'group', linkedChatTitle: null });
    pendingUpdates = [
      { update_id: 7, message: { chat: { id: 101, type: 'private', title: 'Exec' }, text: '/start code-u1-xxxxxxxx' } },
      { update_id: 8, message: { chat: { id: -100, type: 'supergroup', title: 'Execs' }, text: '/start@news_bot code-u1-xxxxxxxx' } },
    ];
    expect(await verify('u1', 'code-u1-xxxxxxxx')).toEqual({ linked: true, chatTitle: 'Execs' });
    expect([...links.get('u1')!.values()].map((l) => l.chatId)).toEqual([-100]);
    expect(sent[0]).toMatchObject({ chatId: 101, text: expect.stringContaining('connects a group or topic') });
  });

  it('keeps several connections, sends notifications to all of them, and disconnects one', async () => {
    links.set(
      'u1',
      new Map([
        ['101_0', { id: '101_0', chatId: 101, topicId: null, chatTitle: 'Exec', kind: 'private', linkedAt: '2026-10-28T01:00:00Z' }],
        ['-100_42', { id: '-100_42', chatId: -100, topicId: 42, chatTitle: 'Execs › Acme', kind: 'group', linkedAt: '2026-10-28T02:00:00Z' }],
        ['-300_0', { id: '-300_0', chatId: -300, topicId: null, chatTitle: 'Old group', kind: 'group', linkedAt: '2026-10-28T03:00:00Z' }],
      ]),
    );
    failingChat = -300; // the bot was removed from this one: the others still get the message
    expect(await notifyAccount('u1', 'Digest')).toBe(true);
    expect(sent.map(({ chatId, topicId }) => ({ chatId, topicId }))).toEqual([
      { chatId: 101, topicId: null },
      { chatId: -100, topicId: 42 },
    ]);

    expect((await telegram(as('u1', 'POST', '/telegram/links/{id}/test', { pathParameters: { id: '-100_42' } }))).statusCode).toBe(200);
    expect(sent.at(-1)).toMatchObject({ chatId: -100, topicId: 42 });
    expect((await telegram(as('u1', 'DELETE', '/telegram/links/{id}', { pathParameters: { id: '101_0' } }))).statusCode).toBe(204);
    expect([...links.get('u1')!.keys()]).toEqual(['-100_42', '-300_0']);
    expect((await telegram(as('u2', 'DELETE', '/telegram/links/{id}', { pathParameters: { id: '-100_42' } }))).statusCode).toBe(404);
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
  const acme: StockAsset = {
    id: 'yahoo:ACME.JK',
    source: 'yahoo',
    symbol: 'ACME.JK',
    name: 'PT Acme Laboratorium Tbk',
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
    const tools = buildChatTools({ sub: 'u1', assets: [acme] });
    expect(tools).toHaveProperty('getAssetPrices');
    expect(tools.getAssetPrices?.description).toContain('yahoo:ACME.JK = ACME (PT Acme Laboratorium Tbk)');
  });

  it('frames answers with the subject and sentiment basis', () => {
    const subject = { name: 'Acme Labs', context: 'A laboratory chain.', sentimentAsset: acme.id };
    const text = chatInstructions({ subject, asset: acme }, [], [acme]);
    expect(text).toContain('You support a reader who follows Acme Labs.\n\nA laboratory chain.');
    expect(text).toContain('likely effect on the ACME (PT Acme Laboratorium Tbk) share price');
  });

  it('falls back to the categories when a new profile has no subject yet', () => {
    const text = chatInstructions({ subject: DEFAULT_SUBJECT, asset: null }, [], []);
    expect(text).toContain('You support a reader who follows the topics of their news categories.');
    expect(text).toContain('likely effect on the topic each article is about');
  });
});

describe('sentiment rubric', () => {
  it("judges against the profile's asset, or the subject itself without one", () => {
    const acmeLabs = { ...DEFAULT_SETTINGS.subject, name: 'Acme Labs' };
    const price = sentimentRubric(acmeLabs, { id: 'yahoo:BTC-USD', name: 'Bitcoin USD', type: 'CRYPTOCURRENCY' });
    expect(price).toContain('relative to the BTC-USD (Bitcoin USD) price — how an investor');
    expect(price).toContain('positive: likely to support the price');
    const subject = sentimentRubric(acmeLabs, null);
    expect(subject).toContain('relative to Acme Labs — how a well-informed reader');
    expect(subject).toContain('positive: good news for Acme Labs');
    expect(sentimentRubric(DEFAULT_SETTINGS.subject, null)).toContain('negative: bad news for the topic each article is about');
  });
});
