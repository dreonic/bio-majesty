import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Digest } from '@bio-majesty/shared';
import { ddb, queryPrefix, stripKeys, table } from './client';
import { keys, profilePk, type ProfileId } from './keys';

export async function putDigest(profileId: ProfileId, digest: Digest): Promise<void> {
  await ddb().send(
    new PutCommand({ TableName: table(), Item: { ...keys.digest(profileId, digest.createdAt, digest.id), ...digest } }),
  );
}

/** The profile's newest digests first. */
export async function latestDigests(profileId: ProfileId, limit = 1): Promise<Digest[]> {
  const items = await queryPrefix(profilePk(profileId), 'DIGEST#', { descending: true, limit });
  return items.map((i) => stripKeys(i) as unknown as Digest);
}
