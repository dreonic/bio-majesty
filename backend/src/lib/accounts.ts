import { CognitoIdentityProviderClient, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ACCESS_GROUP } from '@bio-majesty/shared';
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
 * Every account, i.e. every member of the `dashboard-users` group. Background jobs (the daily-run
 * dispatcher, the stock refresh) work for these accounts only, so removing someone from the group
 * in the Cognito console also stops their runs. Cached for a few minutes per Lambda instance.
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
