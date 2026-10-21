import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Digest } from '@bio-majesty/shared';
import { ddb, queryPrefix, stripKeys, table } from './client';
import { accountPk, keys } from './keys';

export async function putDigest(sub: string, digest: Digest): Promise<void> {
  await ddb().send(
    new PutCommand({ TableName: table(), Item: { ...keys.digest(sub, digest.createdAt, digest.id), ...digest } }),
  );
}

/** The account's newest digests first. */
export async function latestDigests(sub: string, limit = 1): Promise<Digest[]> {
  const items = await queryPrefix(accountPk(sub), 'DIGEST#', { descending: true, limit });
  return items.map((i) => stripKeys(i) as unknown as Digest);
}
