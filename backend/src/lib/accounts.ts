import { CognitoIdentityProviderClient, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ACCESS_GROUP } from '@bio-majesty/shared';
import { asProfileId, type ProfileId } from '../repo/keys';
import { getProfileRecord, listProfiles } from '../repo/profiles';
import { env } from './env';

/** One dashboard account: a member of the access group. */
export interface Account {
  sub: string;
  email: string | null;
}

let client: CognitoIdentityProviderClient | undefined;
const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; accounts: Account[] } | undefined;

/**
 * Every account, i.e. every member of the `dashboard-users` group. The stock refresh works for
 * these accounts' profiles only, so removing someone from the group in the Cognito console also
 * stops their price refreshes and volume alerts. Cached for a few minutes per Lambda instance.
 */
export async function listAccounts(now = Date.now()): Promise<Account[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.accounts;
  client ??= new CognitoIdentityProviderClient({});
  const accounts: Account[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListUsersInGroupCommand({ UserPoolId: env.userPoolId, GroupName: ACCESS_GROUP, Limit: 60, NextToken: token }),
    );
    for (const user of res.Users ?? []) {
      const attr = (name: string) => user.Attributes?.find((a) => a.Name === name)?.Value ?? null;
      const sub = attr('sub');
      if (sub && user.Enabled !== false) accounts.push({ sub, email: attr('email') });
    }
    token = res.NextToken;
  } while (token);
  cache = { at: now, accounts };
  return accounts;
}

/**
 * Whether the profile's account still has dashboard access: scheduled runs of an account removed
 * from the group (or disabled) are skipped, so removing someone also stops their runs.
 */
export async function profileHasAccess(profileId: ProfileId): Promise<boolean> {
  const profile = await getProfileRecord(profileId);
  return Boolean(profile && (await listAccounts()).some((a) => a.sub === profile.owner));
}

/** Every profile of every account (removing someone from the group also stops their profiles' jobs). */
export async function listAllProfiles(): Promise<{ sub: string; profileId: ProfileId }[]> {
  const out: { sub: string; profileId: ProfileId }[] = [];
  for (const { sub } of await listAccounts()) {
    for (const profile of await listProfiles(sub)) out.push({ sub, profileId: asProfileId(profile.id) });
  }
  return out;
}
