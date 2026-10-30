import { BatchWriteCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { deleteObjects, listKeys, s3Keys } from '../storage/s3';
import { chunk, ddb, table } from './client';
import { profilePk, type ProfileId } from './keys';

/** Delete every item of one partition (with retries for unprocessed writes). Returns how many. */
export async function deletePartition(pk: string): Promise<number> {
  let items = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      }),
    );
    for (const batch of chunk(res.Items ?? [], 25)) {
      let request: Record<string, { DeleteRequest: { Key: Record<string, unknown> } }[]> | undefined = {
        [table()]: batch.map((item) => ({ DeleteRequest: { Key: { PK: item.PK, SK: item.SK } } })),
      };
      while (request && Object.keys(request).length) {
        const out = await ddb().send(new BatchWriteCommand({ RequestItems: request }));
        request = out.UnprocessedItems as typeof request;
      }
      items += batch.length;
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/**
 * Delete everything one profile owns: its partition (its record, news, categories, settings, runs,
 * digests, feedback, chats, Telegram connections, volume alerts) and its objects (article texts,
 * chat histories). Deleting saved articles also removes their vectors: the indexer sees the
 * removals on the table's stream. Shared market data stays (assets nobody tracks are no longer
 * refreshed), and run scratch items expire on their own. Safe to repeat.
 */
export async function deleteProfileData(profileId: ProfileId): Promise<{ items: number; objects: number }> {
  const items = await deletePartition(profilePk(profileId));
  const objects = await listKeys(s3Keys.profilePrefix(profileId));
  if (objects.length) await deleteObjects(objects);
  return { items, objects: objects.length };
}
