import { GetCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_SETTINGS, DEFAULT_SUBJECT, type StockAsset } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asProfileId } from '../src/repo/keys';

process.env.TABLE_NAME = 'test-table';
process.env.DATA_BUCKET = 'test-bucket';

// --- Accounts and their profiles: u1 has Acme (p1) and Beta (p3), u2 has p2 ------------------
const profiles: Record<string, { owner: string; name: string }> = {
  p1: { owner: 'u1', name: 'Acme' },
  p2: { owner: 'u2', name: 'Colleague desk' },
  p3: { owner: 'u1', name: 'Beta' },
};
vi.mock('../src/repo/profiles', () => ({
  getAccountProfile: async (sub: string, id: string) =>
    profiles[id]?.owner === sub ? { id, name: profiles[id]!.name, createdAt: '2026-10-30T00:00:00Z' } : null,
  getProfileRecord: async (id: string) => (profiles[id] ? { id, ...profiles[id], createdAt: '2026-10-30T00:00:00Z' } : null),
}));

// --- Telegram: one bot, many profiles, several connections each ------------------------------
type Link = { id: string; chatId: number; topicId: number | null; chatTitle: string; kind: string; linkedAt: string };
const links = new Map<string, Map<string, Link>>();
const codes = new Map<string, { profileId: string; kind: 'private' | 'group'; linkedChatTitle: string | null }>();
let offset = 0;
let pendingUpdates: import('../src/notify/telegram').TelegramUpdate[] = [];
const sent: { chatId: number; topicId: number | null; text: string; buttonUrl?: string }[] = [];
let failingChat: number | null = null;

vi.mock('../src/repo/telegram', () => ({
  telegramLinkId: (chatId: number, topicId: number | null) => `${chatId}_${topicId ?? 0}`,
  listTelegramLinks: async (profileId: string) => [...(links.get(profileId)?.values() ?? [])],
  putTelegramLink: async (profileId: string, link: Link) => void links.set(profileId, (links.get(profileId) ?? new Map()).set(link.id, link)),
  deleteTelegramLink: async (profileId: string, id: string) => links.get(profileId)?.delete(id) ?? false,
  getUpdateOffset: async () => offset,
  setUpdateOffset: async (o: number) => void (offset = o),
  putLinkCode: async (code: string, profileId: string, kind: 'private' | 'group') => void codes.set(code, { profileId, kind, linkedChatTitle: null }),
  getLinkCode: async (code: string) => (codes.has(code) ? { ...codes.get(code)!, expiresAt: 0 } : null),
  markLinkCodeUsed: async (code: string, title: string) => void (codes.get(code)!.linkedChatTitle = title),
}));
vi.mock('../src/storage/s3', () => ({
  getJson: async () => null,
  deleteObjects: async () => undefined,
  s3Keys: { articleText: (profileId: string, id: string) => `profiles/${profileId}/articles/${id}.json` },
}));
vi.mock('../src/notify/telegram', async (original) => ({
  ...(await original<typeof import('../src/notify/telegram')>()),
  isTelegramConfigured: async () => true,
  getBotUsername: async () => 'news_bot',
  getUpdates: async (from: number) => pendingUpdates.filter((u) => u.update_id >= from),
  sendMessage: async (chatId: number, text: string, opts: { topicId?: number | null; buttonUrl?: string } = {}) => {
    if (chatId === failingChat) throw new Error('Telegram sendMessage failed: bot was kicked from the group');
    sent.push({ chatId, topicId: opts.topicId ?? null, text, buttonUrl: opts.buttonUrl });
  },
}));

process.env.DASHBOARD_URL = 'https://news.example.com';
const telegram = (await import('../src/handlers/api/telegram')).handler;
const { notifyProfile } = await import('../src/notify/notify');
const news = (await import('../src/handlers/api/news')).handler;
const { buildChatTools, chatInstructions } = await import('../src/ai/chat-agent');
const { sentimentRubric } = await import('../src/ai/prompts');

/** A request from account `sub` working on `profile` (the X-Profile-Id header; omitted with null). */
const as = (sub: string, profile: string | null, method: string, resource: string, extra: Partial<APIGatewayProxyEvent> = {}) =>
  ({
    httpMethod: method,
    resource,
    headers: profile ? { 'x-profile-id': profile } : {},
    requestContext: { authorizer: { claims: { sub, 'cognito:groups': 'dashboard-users' } } },
    ...extra,
  }) as unknown as APIGatewayProxyEvent;

describe('Telegram linking with several profiles', () => {
  beforeEach(() => {
    links.clear();
    codes.clear();
    offset = 0;
    sent.length = 0;
    failingChat = null;
    codes.set('code-p1-xxxxxxxx', { profileId: 'p1', kind: 'private', linkedChatTitle: null });
    codes.set('code-p2-xxxxxxxx', { profileId: 'p2', kind: 'private', linkedChatTitle: null });
    pendingUpdates = [
      { update_id: 7, message: { chat: { id: 101, type: 'private', title: 'Exec' }, text: '/start code-p1-xxxxxxxx' } },
      { update_id: 8, message: { chat: { id: 202, type: 'private', title: 'Colleague' }, text: '/start code-p2-xxxxxxxx' } },
    ];
  });

  const verify = (sub: string, profile: string, code: string) =>
    telegram(as(sub, profile, 'POST', '/telegram/link/verify', { body: JSON.stringify({ code }) })).then((r) => JSON.parse(r.body));

  it("links every profile whose /start is in the batch, so one profile's check can't swallow another's", async () => {
    expect(await verify('u1', 'p1', 'code-p1-xxxxxxxx')).toEqual({ linked: true, chatTitle: 'Exec' });
    expect(offset).toBe(9); // both messages are consumed by this one check...
    expect([...links.get('p2')!.values()]).toMatchObject([{ chatId: 202 }]); // ...and the colleague's profile is linked too
    expect(await verify('u2', 'p2', 'code-p2-xxxxxxxx')).toEqual({ linked: true, chatTitle: 'Colleague' });
    expect(sent.map((s) => s.chatId).sort()).toEqual([101, 202]);
    expect(sent.find((s) => s.chatId === 101)?.text).toBe('✅ Connected. The news digests and alerts of <b>Acme</b> will come here.');
  });

  it("refuses another profile's link code, even of the same account", async () => {
    expect((await telegram(as('u2', 'p2', 'POST', '/telegram/link/verify', { body: JSON.stringify({ code: 'code-p1-xxxxxxxx' }) }))).statusCode).toBe(400);
    expect((await telegram(as('u1', 'p3', 'POST', '/telegram/link/verify', { body: JSON.stringify({ code: 'code-p1-xxxxxxxx' }) }))).statusCode).toBe(400);
  });

  it('links a topic of a forum supergroup, and replies there', async () => {
    codes.set('code-p1-xxxxxxxx', { profileId: 'p1', kind: 'group', linkedChatTitle: null });
    codes.set('code-p2-xxxxxxxx', { profileId: 'p2', kind: 'group', linkedChatTitle: null });
    pendingUpdates = [
      // Meant for another bot in the same group: ignored.
      { update_id: 7, message: { chat: { id: -100, type: 'supergroup', title: 'Execs' }, text: '/start@other_bot code-p1-xxxxxxxx' } },
      {
        update_id: 8,
        message: {
          chat: { id: -100, type: 'supergroup', title: 'Execs' },
          text: '/start@News_Bot code-p1-xxxxxxxx',
          message_thread_id: 42,
          is_topic_message: true,
          reply_to_message: { forum_topic_created: { name: 'Acme' } },
        },
      },
      // A plain group (or the General topic): no topic.
      { update_id: 9, message: { chat: { id: -200, type: 'group', title: 'Team' }, text: '/start@news_bot code-p2-xxxxxxxx' } },
    ];
    expect(await verify('u1', 'p1', 'code-p1-xxxxxxxx')).toEqual({ linked: true, chatTitle: 'Execs › Acme' });
    expect([...links.get('p1')!.values()]).toMatchObject([{ id: '-100_42', chatId: -100, topicId: 42, kind: 'group' }]);
    expect([...links.get('p2')!.values()]).toMatchObject([{ id: '-200_0', chatId: -200, topicId: null, chatTitle: 'Team' }]);
    expect(sent.map(({ chatId, topicId }) => ({ chatId, topicId }))).toEqual([
      { chatId: -100, topicId: 42 },
      { chatId: -200, topicId: null },
    ]);
  });

  it("won't let a private chat take a code meant for a group (Telegram may send /start by itself)", async () => {
    codes.set('code-p1-xxxxxxxx', { profileId: 'p1', kind: 'group', linkedChatTitle: null });
    pendingUpdates = [
      { update_id: 7, message: { chat: { id: 101, type: 'private', title: 'Exec' }, text: '/start code-p1-xxxxxxxx' } },
      { update_id: 8, message: { chat: { id: -100, type: 'supergroup', title: 'Execs' }, text: '/start@news_bot code-p1-xxxxxxxx' } },
    ];
    expect(await verify('u1', 'p1', 'code-p1-xxxxxxxx')).toEqual({ linked: true, chatTitle: 'Execs' });
    expect([...links.get('p1')!.values()].map((l) => l.chatId)).toEqual([-100]);
    expect(sent[0]).toMatchObject({ chatId: 101, text: expect.stringContaining('connects a group or topic') });
  });

  it('keeps several connections, sends notifications to all of them under the profile name, and disconnects one', async () => {
    links.set(
      'p1',
      new Map([
        ['101_0', { id: '101_0', chatId: 101, topicId: null, chatTitle: 'Exec', kind: 'private', linkedAt: '2026-10-28T01:00:00Z' }],
        ['-100_42', { id: '-100_42', chatId: -100, topicId: 42, chatTitle: 'Execs › Acme', kind: 'group', linkedAt: '2026-10-28T02:00:00Z' }],
        ['-300_0', { id: '-300_0', chatId: -300, topicId: null, chatTitle: 'Old group', kind: 'group', linkedAt: '2026-10-28T03:00:00Z' }],
      ]),
    );
    failingChat = -300; // the bot was removed from this one: the others still get the message
    expect(await notifyProfile(asProfileId('p1'), 'Digest', { path: '/?tab=review' })).toBe(true);
    expect(sent.map(({ chatId, topicId }) => ({ chatId, topicId }))).toEqual([
      { chatId: 101, topicId: null },
      { chatId: -100, topicId: 42 },
    ]);
    // Several profiles may post to one group: each message says whose it is and opens that profile.
    expect(sent[0]).toMatchObject({ text: '<b>Acme</b>\nDigest', buttonUrl: 'https://news.example.com/?tab=review&profile=p1' });

    expect((await telegram(as('u1', 'p1', 'POST', '/telegram/links/{id}/test', { pathParameters: { id: '-100_42' } }))).statusCode).toBe(200);
    expect(sent.at(-1)).toMatchObject({ chatId: -100, topicId: 42 });
    expect((await telegram(as('u1', 'p1', 'DELETE', '/telegram/links/{id}', { pathParameters: { id: '101_0' } }))).statusCode).toBe(204);
    expect([...links.get('p1')!.keys()]).toEqual(['-100_42', '-300_0']);
    expect((await telegram(as('u1', 'p3', 'DELETE', '/telegram/links/{id}', { pathParameters: { id: '-100_42' } }))).statusCode).toBe(404);
  });
});

describe('news is per profile', () => {
  const db = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    db.reset();
    // Only profile p1 (account u1) has article a1.
    db.on(GetCommand).callsFake((input: GetCommand['input']) =>
      input.Key?.PK === 'PROFILE#p1' && input.Key?.SK === 'ART#a1' ? { Item: { ...input.Key, id: 'a1', status: 'APPROVED', title: 'Laba naik' } } : {},
    );
    db.on(QueryCommand).resolves({ Items: [] });
  });

  const open = (sub: string, profile: string | null) => news(as(sub, profile, 'GET', '/news/{id}', { pathParameters: { id: 'a1' } }));

  it("opens the article only in its own profile, not in the account's other profiles", async () => {
    expect((await open('u1', 'p1')).statusCode).toBe(200);
    expect((await open('u1', 'p3')).statusCode).toBe(404);
  });

  it("can't use another account's profile, or no profile at all", async () => {
    const other = await open('u2', 'p1');
    expect(other.statusCode).toBe(404);
    expect(JSON.parse(other.body).message).toBe('Profile not found');
    expect((await open('u2', 'nope-not-an-id!')).statusCode).toBe(404);
    const none = await open('u1', null);
    expect(none.statusCode).toBe(400);
    expect(JSON.parse(none.body).message).toContain('X-Profile-Id');
    expect(db.commandCalls(GetCommand)).toHaveLength(0); // none of them reached the article
  });

  it("lists only the profile's news", async () => {
    await news(as('u1', 'p3', 'GET', '/news', { queryStringParameters: { status: 'APPROVED' } }));
    const queried = db.commandCalls(QueryCommand).map((c) => c.args[0].input.ExpressionAttributeValues?.[':pk']);
    expect(queried).toEqual(['PROFILE#p3#STATUS#APPROVED']);
  });
});

describe('chat over one profile', () => {
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

  it("offers prices only for the profile's own assets", () => {
    expect(Object.keys(buildChatTools({ profileId: asProfileId('p1'), assets: [] }))).toEqual(['searchNews', 'listNews', 'getArticle']);
    const tools = buildChatTools({ profileId: asProfileId('p1'), assets: [acme] });
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
