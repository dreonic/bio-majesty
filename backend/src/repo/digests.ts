import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Digest } from '@bio-majesty/shared';
import { ddb, stripKeys, table } from './client';
import { keys } from './keys';

export async function putDigest(digest: Digest): Promise<void> {
  await ddb().send(
    new PutCommand({ TableName: table(), Item: { ...keys.digest(digest.createdAt, digest.id), ...digest } }),
  );
}

export async function latestDigests(limit = 1): Promise<Digest[]> {
  const res = await ddb().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'DIGEST' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []).map((i) => stripKeys(i) as unknown as Digest);
}
