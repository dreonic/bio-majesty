import { DeleteCommand, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { ProfileSummary } from '@bio-majesty/shared';
import { randomId } from '../lib/ids';
import { ddb, queryPrefix, stripKeys, table } from './client';
import { accountPk, asProfileId, keys, type ProfileId } from './keys';

/** A profile's own record: what the account's list says, plus the account it belongs to. */
export interface ProfileRecord extends ProfileSummary {
  /** The account's Cognito sub. */
  owner: string;
}

/** The account's profiles, oldest first. */
export async function listProfiles(sub: string): Promise<ProfileSummary[]> {
  const items = await queryPrefix(accountPk(sub), 'PROFILE#');
  return items.map((i) => stripKeys(i) as unknown as ProfileSummary).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** One of the account's profiles; null for a missing profile and for another account's. */
export async function getAccountProfile(sub: string, id: string): Promise<ProfileSummary | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.accountProfile(sub, asProfileId(id)) }));
  return res.Item ? (stripKeys(res.Item) as unknown as ProfileSummary) : null;
}

/** A profile's own record, for jobs that only know the profile (its name in notifications). */
export async function getProfileRecord(profileId: ProfileId): Promise<ProfileRecord | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.profile(profileId) }));
  return res.Item ? (stripKeys(res.Item) as unknown as ProfileRecord) : null;
}

/** A new, empty profile: listed under the account, with its own record in its partition. */
export async function createProfile(sub: string, name: string, now = new Date()): Promise<ProfileSummary> {
  const profile: ProfileSummary = { id: randomId(12), name, createdAt: now.toISOString() };
  const id = asProfileId(profile.id);
  await ddb().send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: table(), Item: { ...keys.accountProfile(sub, id), ...profile }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: table(), Item: { ...keys.profile(id), ...profile, owner: sub }, ConditionExpression: 'attribute_not_exists(PK)' } },
      ],
    }),
  );
  return profile;
}

/** Rename one of the account's profiles (both copies of its name). */
export async function renameProfile(sub: string, profileId: ProfileId, name: string): Promise<void> {
  const update = {
    TableName: table(),
    UpdateExpression: 'SET #name = :n',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: { '#name': 'name' },
    ExpressionAttributeValues: { ':n': name },
  };
  await ddb().send(
    new TransactWriteCommand({
      TransactItems: [{ Update: { ...update, Key: keys.accountProfile(sub, profileId) } }, { Update: { ...update, Key: keys.profile(profileId) } }],
    }),
  );
}

/** Take a profile off the account's list: the account loses access at once; its data is deleted separately. */
export async function removeAccountProfile(sub: string, profileId: ProfileId): Promise<void> {
  await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.accountProfile(sub, profileId) }));
}
