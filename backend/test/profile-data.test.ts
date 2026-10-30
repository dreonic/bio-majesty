import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asProfileId } from '../src/repo/keys';

process.env.TABLE_NAME = 'test-table';
process.env.DATA_BUCKET = 'test-bucket';

const objects: Record<string, string[]> = {
  'profiles/p1/': ['profiles/p1/articles/a1.json', 'profiles/p1/chats/c1.json', 'profiles/p1/chats/c2.json'],
};
const deleted: string[][] = [];
vi.mock('../src/storage/s3', () => ({
  listKeys: async (prefix: string) => objects[prefix] ?? [],
  deleteObjects: async (keys: string[]) => void deleted.push(keys),
  s3Keys: { profilePrefix: (profileId: string) => `profiles/${profileId}/` },
}));

const db = mockClient(DynamoDBDocumentClient);
const { deleteProfileData } = await import('../src/repo/profile-data');

beforeEach(() => {
  db.reset();
  deleted.length = 0;
});

describe('deleteProfileData', () => {
  it("deletes every item of the profile's partition across pages, retrying unprocessed ones, and its objects", async () => {
    const items = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ PK: 'PROFILE#p1', SK: `ART#${from + i}` }));
    db.on(QueryCommand)
      .resolvesOnce({ Items: items(0, 30), LastEvaluatedKey: { PK: 'PROFILE#p1', SK: 'ART#29' } })
      .resolvesOnce({ Items: items(30, 5) });
    db.on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { 'test-table': [{ DeleteRequest: { Key: { PK: 'PROFILE#p1', SK: 'ART#0' } } }] } })
      .resolves({});

    expect(await deleteProfileData(asProfileId('p1'))).toEqual({ items: 35, objects: 3 });

    const queries = db.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(queries.every((q) => q.ExpressionAttributeValues?.[':pk'] === 'PROFILE#p1')).toBe(true);
    // 30 + 5 items: batches of 25, 5 and 5, plus one retry of the unprocessed item.
    const batches = db.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!['test-table']!.length);
    expect(batches).toEqual([25, 1, 5, 5]);
    expect(deleted).toEqual([objects['profiles/p1/']]);
  });
});
