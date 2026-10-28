import {
  ACCESS_GROUP,
  ADMIN_GROUP,
  InviteUserRequestSchema,
  isAdmin,
  UpdateUserRequestSchema,
  type AdminUser,
  type AdminUsersResponse,
} from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { invokeAsync } from '../../lib/aws';
import { env } from '../../lib/env';
import { badRequest, conflict, forbidden, json, noContent, notFound, parseBody, pathParam, type AuthUser } from '../../lib/http';
import { createRouter, type RouteHandler } from '../../lib/router';
import { getUser, inviteUser, listUsers, resendInvite, setEnabled, setGroup, signOutEverywhere } from '../../lib/users';
import { listRuns } from '../../repo/runs';
import type { AccountDeleteEvent } from '../account-delete';

/** A run older than this is treated as stuck, not in progress. */
const RUN_IN_PROGRESS_MS = 6 * 60 * 60 * 1000;

const claims = (event: APIGatewayProxyEvent) => (event.requestContext?.authorizer?.claims ?? {}) as Record<string, string>;

/** Admin routes also need the admins group (the router has already checked dashboard access). */
const adminOnly =
  (fn: RouteHandler): RouteHandler =>
  (event, user) => {
    if (!isAdmin(claims(event)['cognito:groups'])) throw forbidden('Only admins can manage users.');
    return fn(event, user);
  };

async function target(event: APIGatewayProxyEvent): Promise<AdminUser> {
  const user = await getUser(pathParam(event, 'username'));
  if (!user) throw notFound('No such user');
  return user;
}

/** An admin can't lock themselves out (and so maybe leave no admin at all). */
function notSelf(user: AdminUser, me: AuthUser, what: string): void {
  if (user.sub === me.sub) throw forbidden(`You can't ${what} yourself. Ask another admin.`);
}

export const handler = createRouter({
  'GET /admin/users': adminOnly(async (event) => {
    const body: AdminUsersResponse = { users: await listUsers(), me: claims(event)['cognito:username'] ?? '' };
    return json(200, body);
  }),

  'POST /admin/users': adminOnly(async (event) => {
    const { email } = parseBody(event, InviteUserRequestSchema);
    return json(201, await inviteUser(email));
  }),

  'POST /admin/users/{username}/invite': adminOnly(async (event) => {
    const user = await target(event);
    if (user.status !== 'FORCE_CHANGE_PASSWORD') throw badRequest('This user has already signed in; there is no invitation to resend.');
    await resendInvite(user.username);
    return noContent();
  }),

  'PATCH /admin/users/{username}': adminOnly(async (event, me) => {
    const change = parseBody(event, UpdateUserRequestSchema);
    const user = await target(event);
    if (change.access === false) notSelf(user, me, 'remove access for');
    if (change.admin === false) notSelf(user, me, 'remove the admin role from');
    if (change.enabled === false) notSelf(user, me, 'disable');
    if (change.admin === true && !(change.access ?? user.access)) throw badRequest('Give the user access before making them an admin.');

    if (change.access !== undefined) await setGroup(user.username, ACCESS_GROUP, change.access);
    if (change.admin !== undefined) await setGroup(user.username, ADMIN_GROUP, change.admin);
    // Admins need access, so removing access also removes the admin role.
    if (change.access === false && user.admin && change.admin === undefined) await setGroup(user.username, ADMIN_GROUP, false);
    if (change.enabled !== undefined) await setEnabled(user.username, change.enabled);
    if (change.access === false || change.admin === false || change.enabled === false) await signOutEverywhere(user.username);
    return json(200, (await getUser(user.username)) ?? user);
  }),

  'DELETE /admin/users/{username}': adminOnly(async (event, me) => {
    const user = await target(event);
    notSelf(user, me, 'delete');
    // A run in flight would write news back into the deleted partition.
    const runs = await listRuns(user.sub, 5);
    if (runs.some((r) => r.status === 'running' && Date.now() - Date.parse(r.startedAt) < RUN_IN_PROGRESS_MS)) {
      throw conflict('A news run is in progress for this account. Try again when it has finished (usually within a few minutes).');
    }
    // Stop everything now (sign-in, background runs); the worker deletes the data, then the user.
    await setGroup(user.username, ACCESS_GROUP, false);
    if (user.admin) await setGroup(user.username, ADMIN_GROUP, false);
    await setEnabled(user.username, false);
    await signOutEverywhere(user.username);
    const payload: AccountDeleteEvent = { sub: user.sub, username: user.username };
    await invokeAsync(env.accountDeleteFunction, payload);
    return json(202, { deleting: true });
  }),
});
