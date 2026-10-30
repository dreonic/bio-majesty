import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DeleteNewsResponse } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TABLE_NAME = 'test-table';
process.env.DATA_BUCKET = 'test-bucket';

const deletedTexts: string[][] = [];
vi.mock('../src/storage/s3', () => ({
  deleteObjects: async (keys: string[]) => void deletedTexts.push(keys),
  getJson: async () => null,
  s3Keys: { articleText: (profileId: string, id: string) => `profiles/${profileId}/articles/${id}.json` },
}));
// Account u1 owns profile p1, u2 owns p2.
vi.mock('../src/repo/profiles', () => ({
  getAccountProfile: async (sub: string, id: string) => ({ u1: 'p1', u2: 'p2' } as Record<string, string>)[sub] === id ? { id, name: id, createdAt: '' } : null,
}));

const db = mockClient(DynamoDBDocumentClient);
const { handler } = await import('../src/handlers/api/news');

const request = (body: unknown, sub = 'u1', profile = 'p1') =>
  handler({
    httpMethod: 'POST',
    resource: '/news/delete',
    headers: { 'X-Profile-Id': profile },
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub, 'cognito:groups': 'dashboard-users' } } },
  } as unknown as APIGatewayProxyEvent);

interface FakeArticle {
  status: string;
  aliasIds: Set<string>;
  deletedAt?: string;
}

/** p1's partition: articles by id, and dedupe keys (alias id -> article id). */
let articles: Map<string, FakeArticle>;
let aliases: Map<string, string>;

const failCondition = () => {
  throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
};

beforeEach(() => {
  deletedTexts.length = 0;
  const article = (status: string, ...ids: string[]): FakeArticle => ({ status, aliasIds: new Set(ids) });
  articles = new Map([
    ['skipped1', article('REJECTED', 'url#s1', 'title#s1')],
    ['skipped2', article('REJECTED', 'url#s2')],
    ['filtered1', article('FILTERED', 'url#f1')],
    ['pending1', article('PENDING', 'url#p1')],
    ['saved1', article('APPROVED', 'url#a1')],
  ]);
  aliases = new Map([...articles].flatMap(([id, a]) => [...a.aliasIds].map((alias) => [alias, id] as [string, string])));
  // Another article took over one of skipped1's keys: deleting skipped1 must leave it.
  aliases.set('title#s1', 'other');

  db.reset();
  db.on(DeleteCommand).callsFake((input: DeleteCommand['input']) => {
    if (input.Key?.PK !== 'PROFILE#p1') failCondition();
    const sk = String(input.Key?.SK);
    const values = input.ExpressionAttributeValues ?? {};
    if (sk.startsWith('ALIAS#')) {
      const alias = sk.replace(/^ALIAS#/, '');
      if (aliases.get(alias) !== values[':id']) failCondition();
      aliases.delete(alias);
      return {};
    }
    const id = sk.replace(/^ART#/, '');
    const a = articles.get(id);
    if (!a || a.status !== values[':rejected']) failCondition();
    articles.delete(id);
    return { Attributes: { SK: sk, status: a!.status, aliasIds: a!.aliasIds } };
  });
  db.on(UpdateCommand).callsFake((input: UpdateCommand['input']) => {
    const id = String(input.Key?.SK).replace(/^ART#/, '');
    const a = input.Key?.PK === 'PROFILE#p1' ? articles.get(id) : undefined;
    if (!a || a.status !== input.ExpressionAttributeValues?.[':filtered'] || a.deletedAt) failCondition();
    a!.deletedAt = String(input.ExpressionAttributeValues?.[':now']);
    return {};
  });
  // One article per page of a status list (GSI1), continuing after the last key like DynamoDB.
  db.on(QueryCommand).callsFake((input: QueryCommand['input']) => {
    const status = String(input.ExpressionAttributeValues?.[':pk']).replace(/^PROFILE#p1#STATUS#/, '');
    const order = [...articles.keys()];
    const after = input.ExclusiveStartKey ? order.indexOf(String(input.ExclusiveStartKey.SK).replace(/^ART#/, '')) : -1;
    const listed = (id: string) => articles.get(id)?.status === status && !articles.get(id)?.deletedAt;
    const rest = order.slice(after + 1).filter(listed);
    const page = rest.slice(0, 1);
    return {
      Items: page.map((id) => ({ SK: `ART#${id}` })),
      LastEvaluatedKey: rest.length > 1 ? { SK: `ART#${page[0]}` } : undefined,
    };
  });
});

describe('POST /news/delete', () => {
  it('deletes chosen skipped articles, hides filtered ones, and never touches pending or saved news', async () => {
    const res = await request({ ids: ['skipped1', 'filtered1', 'pending1', 'saved1', 'missing1'] });
    const body = JSON.parse(res.body) as DeleteNewsResponse;
    expect(res.statusCode).toBe(200);
    expect(body.deleted).toBe(2);
    expect(body.failed.map((f) => f.id).sort()).toEqual(['missing1', 'pending1', 'saved1']);
    expect([...articles.keys()].sort()).toEqual(['filtered1', 'pending1', 'saved1', 'skipped2']);
    expect(articles.get('filtered1')?.deletedAt).toBeTruthy();
    expect(deletedTexts.flat().sort()).toEqual(['profiles/p1/articles/filtered1.json', 'profiles/p1/articles/skipped1.json']);
  });

  it('forgets a recycle-bin article, so a later run or backfill can find it again', async () => {
    await request({ ids: ['skipped1'] });
    expect(aliases.has('url#s1')).toBe(false);
    // A key another article took over stays.
    expect(aliases.get('title#s1')).toBe('other');
  });

  it("keeps a filtered article's dedupe keys, so later runs keep filtering it out", async () => {
    await request({ ids: ['filtered1'] });
    expect(aliases.get('url#f1')).toBe('filtered1');
    // Hidden from the "Filtered by AI" list (and its count) from now on.
    const again = JSON.parse((await request({ status: 'FILTERED' })).body) as DeleteNewsResponse;
    expect(again.deleted).toBe(0);
  });

  it('empties the recycle bin across pages', async () => {
    const body = JSON.parse((await request({ status: 'REJECTED' })).body) as DeleteNewsResponse;
    expect(body).toEqual({ deleted: 2, failed: [], more: false });
    expect([...articles.keys()].sort()).toEqual(['filtered1', 'pending1', 'saved1']);
    expect([...aliases.keys()].sort()).toEqual(['title#s1', 'url#a1', 'url#f1', 'url#p1']);
  });

  it("can't touch another profile's news", async () => {
    const body = JSON.parse((await request({ ids: ['skipped1', 'filtered1'] }, 'u2', 'p2')).body) as DeleteNewsResponse;
    expect(body.deleted).toBe(0);
    expect(articles.size).toBe(5);
    expect((await request({ ids: ['skipped1'] }, 'u2', 'p1')).statusCode).toBe(404);
    expect(articles.size).toBe(5);
  });

  it('refuses statuses that are not deletable', async () => {
    expect((await request({ status: 'APPROVED' })).statusCode).toBe(400);
    expect((await request({ status: 'PENDING' })).statusCode).toBe(400);
    expect((await request({ ids: [] })).statusCode).toBe(400);
    expect(db.commandCalls(DeleteCommand)).toHaveLength(0);
  });
});
