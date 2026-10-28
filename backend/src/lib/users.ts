import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UserNotFoundException,
  UsernameExistsException,
  type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import { ACCESS_GROUP, ADMIN_GROUP, type AdminUser } from '@bio-majesty/shared';
import { env } from './env';
import { conflict } from './http';

let client: CognitoIdentityProviderClient | undefined;
const cognito = () => (client ??= new CognitoIdentityProviderClient({}));

interface CognitoUser {
  Username?: string;
  Attributes?: AttributeType[];
  UserAttributes?: AttributeType[];
  UserStatus?: string;
  Enabled?: boolean;
  UserCreateDate?: Date;
}

function toAdminUser(user: CognitoUser, groups: { access: boolean; admin: boolean }): AdminUser {
  const attrs = user.Attributes ?? user.UserAttributes ?? [];
  const attr = (name: string) => attrs.find((a) => a.Name === name)?.Value ?? null;
  const username = user.Username ?? '';
  return {
    username,
    sub: attr('sub') ?? '',
    email: attr('email'),
    name: attr('name'),
    // Google sign-ins get usernames like Google_1234567890 (the provider name, then the Google ID).
    provider: /^google_/i.test(username) ? 'google' : 'email',
    status: user.UserStatus ?? 'UNKNOWN',
    enabled: user.Enabled !== false,
    ...groups,
    createdAt: (user.UserCreateDate ?? new Date(0)).toISOString(),
  };
}

async function groupMembers(group: string): Promise<Set<string>> {
  const out = new Set<string>();
  let token: string | undefined;
  do {
    const res = await cognito().send(new ListUsersInGroupCommand({ UserPoolId: env.userPoolId, GroupName: group, Limit: 60, NextToken: token }));
    for (const user of res.Users ?? []) if (user.Username) out.add(user.Username);
    token = res.NextToken;
  } while (token);
  return out;
}

/** Every user of the pool, with their dashboard access and admin role, oldest first. */
export async function listUsers(): Promise<AdminUser[]> {
  const [access, admins] = await Promise.all([groupMembers(ACCESS_GROUP), groupMembers(ADMIN_GROUP)]);
  const users: AdminUser[] = [];
  let token: string | undefined;
  do {
    const res = await cognito().send(new ListUsersCommand({ UserPoolId: env.userPoolId, Limit: 60, PaginationToken: token }));
    for (const user of res.Users ?? []) {
      const username = user.Username ?? '';
      users.push(toAdminUser(user, { access: access.has(username), admin: admins.has(username) }));
    }
    token = res.PaginationToken;
  } while (token);
  return users.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getUser(username: string): Promise<AdminUser | null> {
  try {
    const [user, groups] = await Promise.all([
      cognito().send(new AdminGetUserCommand({ UserPoolId: env.userPoolId, Username: username })),
      cognito().send(new AdminListGroupsForUserCommand({ UserPoolId: env.userPoolId, Username: username, Limit: 60 })),
    ]);
    const names = new Set((groups.Groups ?? []).map((g) => g.GroupName));
    return toAdminUser(user, { access: names.has(ACCESS_GROUP), admin: names.has(ADMIN_GROUP) });
  } catch (err) {
    if (err instanceof UserNotFoundException) return null;
    throw err;
  }
}

/** Create an email user with dashboard access; Cognito emails them a temporary password (valid 7 days). */
export async function inviteUser(email: string): Promise<AdminUser> {
  try {
    const res = await cognito().send(
      new AdminCreateUserCommand({
        UserPoolId: env.userPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    const user = res.User!;
    await setGroup(user.Username!, ACCESS_GROUP, true);
    return toAdminUser(user, { access: true, admin: false });
  } catch (err) {
    if (err instanceof UsernameExistsException) throw conflict(`${email} already has a user`);
    throw err;
  }
}

/** Send an invited user (still FORCE_CHANGE_PASSWORD) a new temporary password. */
export async function resendInvite(username: string): Promise<void> {
  await cognito().send(
    new AdminCreateUserCommand({ UserPoolId: env.userPoolId, Username: username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }),
  );
}

export async function setGroup(username: string, group: string, member: boolean): Promise<void> {
  const input = { UserPoolId: env.userPoolId, Username: username, GroupName: group };
  await cognito().send(member ? new AdminAddUserToGroupCommand(input) : new AdminRemoveUserFromGroupCommand(input));
}

export async function setEnabled(username: string, enabled: boolean): Promise<void> {
  const input = { UserPoolId: env.userPoolId, Username: username };
  await cognito().send(enabled ? new AdminEnableUserCommand(input) : new AdminDisableUserCommand(input));
}

/**
 * Revoke the user's refresh tokens, so a renewed session can't outlive a change of groups or a
 * disable. Tokens already issued stay valid until they expire (up to an hour).
 */
export async function signOutEverywhere(username: string): Promise<void> {
  await cognito().send(new AdminUserGlobalSignOutCommand({ UserPoolId: env.userPoolId, Username: username }));
}

/** Delete the Cognito user (already gone is fine). */
export async function deleteUser(username: string): Promise<void> {
  try {
    await cognito().send(new AdminDeleteUserCommand({ UserPoolId: env.userPoolId, Username: username }));
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
  }
}
