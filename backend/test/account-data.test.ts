import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TABLE_NAME = 'test-table';
process.env.DATA_BUCKET = 'test-bucket';

const objects: Record<string, string[]> = {
  'users/s1/': ['users/s1/articles/a1.json'],
  'chats/s1/': ['chats/s1/c1.json', 'chats/s1/c2.json'],
};
const deleted: string[][] = [];
vi.mock('../src/storage/s3', () => ({
  listKeys: async (prefix: string) => objects[prefix] ?? [],
  deleteObjects: async (keys: string[]) => void deleted.push(keys),
  s3Keys: { accountPrefixes: (sub: string) => [`users/${sub}/`, `chats/${sub}/`] },
}));

const db = mockClient(DynamoDBDocumentClient);
const { deleteAccountData } = await import('../src/repo/account-data');

beforeEach(() => {
  db.reset();
  deleted.length = 0;
});

describe('deleteAccountData', () => {
  it("deletes every item of the account's partition across pages, retrying unprocessed ones, and its objects", async () => {
    const items = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ PK: 'USER#s1', SK: `ART#${from + i}` }));
    db.on(QueryCommand)
      .resolvesOnce({ Items: items(0, 30), LastEvaluatedKey: { PK: 'USER#s1', SK: 'ART#29' } })
      .resolvesOnce({ Items: items(30, 5) });
    db.on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { 'test-table': [{ DeleteRequest: { Key: { PK: 'USER#s1', SK: 'ART#0' } } }] } })
      .resolves({});

    expect(await deleteAccountData('s1')).toEqual({ items: 35, objects: 3 });

    const queries = db.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(queries.every((q) => q.ExpressionAttributeValues?.[':pk'] === 'USER#s1')).toBe(true);
    // 30 + 5 items: batches of 25, 5 and 5, plus one retry of the unprocessed item.
    const batches = db.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!['test-table']!.length);
    expect(batches).toEqual([25, 1, 5, 5]);
    expect(deleted).toEqual([['users/s1/articles/a1.json', 'chats/s1/c1.json', 'chats/s1/c2.json']]);
  });
});
