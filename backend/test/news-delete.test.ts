import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
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
  s3Keys: { articleText: (id: string) => `articles/${id}.json` },
}));

const db = mockClient(DynamoDBDocumentClient);
const { handler } = await import('../src/handlers/api/news');

const request = (body: unknown) =>
  handler({
    httpMethod: 'POST',
    resource: '/news/delete',
    headers: {},
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'u1', 'cognito:groups': 'dashboard-users' } } },
  } as unknown as APIGatewayProxyEvent);

/** Articles in the fake table, by id → status. Deletes honour the status condition like DynamoDB. */
let table: Map<string, string>;

beforeEach(() => {
  deletedTexts.length = 0;
  table = new Map([
    ['skipped1', 'REJECTED'],
    ['skipped2', 'REJECTED'],
    ['filtered1', 'FILTERED'],
    ['pending1', 'PENDING'],
    ['saved1', 'APPROVED'],
  ]);
  db.reset();
  db.on(DeleteCommand).callsFake((input: DeleteCommand['input']) => {
    const id = String(input.Key?.PK).replace(/^ART#/, '');
    const allowed = Object.values(input.ExpressionAttributeValues ?? {});
    if (!allowed.includes(table.get(id))) throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
    table.delete(id);
    return {};
  });
  // One article per page, continuing after the last key like DynamoDB (a bin larger than one page).
  const order = [...table.keys()];
  db.on(QueryCommand).callsFake((input: QueryCommand['input']) => {
    const status = String(input.ExpressionAttributeValues?.[':pk']).replace(/^STATUS#/, '');
    const after = input.ExclusiveStartKey ? order.indexOf(String(input.ExclusiveStartKey.PK).replace(/^ART#/, '')) : -1;
    const rest = order.slice(after + 1).filter((id) => table.get(id) === status);
    const page = rest.slice(0, 1);
    return {
      Items: page.map((id) => ({ PK: `ART#${id}` })),
      LastEvaluatedKey: rest.length > 1 ? { PK: `ART#${page[0]}` } : undefined,
    };
  });
});

describe('POST /news/delete', () => {
  it('deletes chosen skipped or filtered articles and their text, and never pending or saved news', async () => {
    const res = await request({ ids: ['skipped1', 'filtered1', 'pending1', 'saved1', 'missing1'] });
    const body = JSON.parse(res.body) as DeleteNewsResponse;
    expect(res.statusCode).toBe(200);
    expect(body.deleted).toBe(2);
    expect(body.failed.map((f) => f.id).sort()).toEqual(['missing1', 'pending1', 'saved1']);
    expect([...table.keys()].sort()).toEqual(['pending1', 'saved1', 'skipped2']);
    expect(deletedTexts.flat().sort()).toEqual(['articles/filtered1.json', 'articles/skipped1.json']);
  });

  it('only deletes article records, so alias records keep later runs from bringing them back', async () => {
    await request({ ids: ['skipped1'] });
    const keys = db.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key);
    expect(keys).toEqual([{ PK: 'ART#skipped1', SK: 'META' }]);
  });

  it('empties the recycle bin across pages', async () => {
    const body = JSON.parse((await request({ status: 'REJECTED' })).body) as DeleteNewsResponse;
    expect(body).toEqual({ deleted: 2, failed: [], more: false });
    expect([...table.keys()].sort()).toEqual(['filtered1', 'pending1', 'saved1']);
  });

  it('refuses statuses that are not deletable', async () => {
    expect((await request({ status: 'APPROVED' })).statusCode).toBe(400);
    expect((await request({ status: 'PENDING' })).statusCode).toBe(400);
    expect((await request({ ids: [] })).statusCode).toBe(400);
    expect(db.commandCalls(DeleteCommand)).toHaveLength(0);
  });
});
