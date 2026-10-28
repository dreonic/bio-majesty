import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AdminUsersResponse } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.TABLE_NAME = 'test-table';
process.env.USER_POOL_ID = 'pool-1';
process.env.ACCOUNT_DELETE_FUNCTION = 'account-delete-fn';

const cognito = mockClient(CognitoIdentityProviderClient);
const db = mockClient(DynamoDBDocumentClient);
const lambda = mockClient(LambdaClient);
const { handler } = await import('../src/handlers/api/admin');

/** The signed-in admin: sub "admin-sub", username "admin-user". */
const request = (method: string, resource: string, opts: { username?: string; body?: unknown; groups?: string } = {}) =>
  handler({
    httpMethod: method,
    resource,
    headers: {},
    pathParameters: opts.username ? { username: opts.username } : null,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    requestContext: {
      authorizer: { claims: { sub: 'admin-sub', 'cognito:username': 'admin-user', 'cognito:groups': opts.groups ?? 'dashboard-users,admins' } },
    },
  } as unknown as APIGatewayProxyEvent);

const attrs = (sub: string, email: string) => [
  { Name: 'sub', Value: sub },
  { Name: 'email', Value: email },
];

/** Target user "u1" (sub s1), with the given groups. */
function givenUser(groups: string[], sub = 's1') {
  cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: attrs(sub, 'u1@example.com'), UserStatus: 'CONFIRMED', Enabled: true });
  cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: groups.map((GroupName) => ({ GroupName })) });
}

beforeEach(() => {
  cognito.reset();
  db.reset();
  lambda.reset();
  db.on(QueryCommand).resolves({ Items: [] });
});

describe('admin API', () => {
  it('refuses members who are not admins', async () => {
    const res = await request('GET', '/admin/users', { groups: 'dashboard-users' });
    expect(res.statusCode).toBe(403);
    expect(cognito.calls()).toHaveLength(0);
  });

  it('lists every user with their access, admin role and sign-in method', async () => {
    cognito.on(ListUsersCommand).resolves({
      Users: [
        { Username: 'Google_123', Attributes: attrs('s2', 'b@example.com'), UserStatus: 'EXTERNAL_PROVIDER', Enabled: true, UserCreateDate: new Date('2026-10-02') },
        { Username: 'admin-user', Attributes: attrs('admin-sub', 'a@example.com'), UserStatus: 'CONFIRMED', Enabled: true, UserCreateDate: new Date('2026-10-01') },
      ],
    });
    cognito.on(ListUsersInGroupCommand, { GroupName: 'dashboard-users' }).resolves({ Users: [{ Username: 'admin-user' }] });
    cognito.on(ListUsersInGroupCommand, { GroupName: 'admins' }).resolves({ Users: [{ Username: 'admin-user' }] });

    const res = await request('GET', '/admin/users');
    const body = JSON.parse(res.body) as AdminUsersResponse;
    expect(body.me).toBe('admin-user');
    expect(body.users.map((u) => [u.username, u.provider, u.access, u.admin])).toEqual([
      ['admin-user', 'email', true, true],
      ['Google_123', 'google', false, false],
    ]);
  });

  it('invites an email user with dashboard access, and rejects a duplicate', async () => {
    cognito.on(AdminCreateUserCommand).resolvesOnce({ User: { Username: 'new-uuid', Attributes: attrs('s3', 'c@example.com') } });
    const res = await request('POST', '/admin/users', { body: { email: 'C@Example.com ' } });
    expect(res.statusCode).toBe(201);
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toMatchObject({ Username: 'c@example.com', DesiredDeliveryMediums: ['EMAIL'] });
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0]!.args[0].input).toMatchObject({ Username: 'new-uuid', GroupName: 'dashboard-users' });

    cognito.on(AdminCreateUserCommand).rejects(new UsernameExistsException({ message: 'exists', $metadata: {} }));
    expect((await request('POST', '/admin/users', { body: { email: 'c@example.com' } })).statusCode).toBe(409);
  });

  it("doesn't let admins remove their own access, admin role or account", async () => {
    givenUser(['dashboard-users', 'admins'], 'admin-sub');
    for (const body of [{ access: false }, { admin: false }, { enabled: false }]) {
      expect((await request('PATCH', '/admin/users/{username}', { username: 'u1', body })).statusCode).toBe(403);
    }
    expect((await request('DELETE', '/admin/users/{username}', { username: 'u1' })).statusCode).toBe(403);
    expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand)).toHaveLength(0);
  });

  it('removing access also removes the admin role and ends their sessions', async () => {
    givenUser(['dashboard-users', 'admins']);
    const res = await request('PATCH', '/admin/users/{username}', { username: 'u1', body: { access: false } });
    expect(res.statusCode).toBe(200);
    expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand).map((c) => c.args[0].input.GroupName)).toEqual(['dashboard-users', 'admins']);
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(1);
  });

  it('only makes users with access admins', async () => {
    givenUser([]);
    expect((await request('PATCH', '/admin/users/{username}', { username: 'u1', body: { admin: true } })).statusCode).toBe(400);
    expect((await request('PATCH', '/admin/users/{username}', { username: 'u1', body: { access: true, admin: true } })).statusCode).toBe(200);
  });

  it('waits for a running news run before deleting', async () => {
    givenUser(['dashboard-users']);
    db.on(QueryCommand).resolves({ Items: [{ id: 'r1', status: 'running', startedAt: new Date().toISOString() }] });
    expect((await request('DELETE', '/admin/users/{username}', { username: 'u1' })).statusCode).toBe(409);
    expect(lambda.calls()).toHaveLength(0);
  });

  it('deletes by locking the user out, then handing the data to the worker', async () => {
    givenUser(['dashboard-users']);
    db.on(QueryCommand).resolves({ Items: [{ id: 'old', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' }] });
    const res = await request('DELETE', '/admin/users/{username}', { username: 'u1' });
    expect(res.statusCode).toBe(202);
    expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand)[0]!.args[0].input.GroupName).toBe('dashboard-users');
    expect(cognito.commandCalls(AdminDisableUserCommand)).toHaveLength(1);
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(1);
    const invoke = lambda.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(invoke.FunctionName).toBe('account-delete-fn');
    expect(invoke.InvocationType).toBe('Event');
    expect(JSON.parse(String(invoke.Payload))).toEqual({ sub: 's1', username: 'u1' });
  });
});
