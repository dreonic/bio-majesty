import { DEFAULT_SETTINGS, type ProfileSummary, type Settings } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DELETE_WORKER_FUNCTION = 'delete-worker-fn';

// --- Accounts' profile lists (u1 has p1 and p3, u2 has p2) ------------------------------------
const lists = new Map<string, ProfileSummary[]>();
const removed: string[] = [];
let nextId = 'pnew';
vi.mock('../src/repo/profiles', () => ({
  listProfiles: async (sub: string) => [...(lists.get(sub) ?? [])],
  getAccountProfile: async (sub: string, id: string) => lists.get(sub)?.find((p) => p.id === id) ?? null,
  createProfile: async (sub: string, name: string) => {
    const profile = { id: nextId, name, createdAt: '2026-10-30T00:00:00.000Z' };
    lists.set(sub, [...(lists.get(sub) ?? []), profile]);
    return profile;
  },
  renameProfile: async (sub: string, id: string, name: string) => void lists.set(sub, lists.get(sub)!.map((p) => (p.id === id ? { ...p, name } : p))),
  removeAccountProfile: async (sub: string, id: string) => {
    removed.push(id);
    lists.set(sub, (lists.get(sub) ?? []).filter((p) => p.id !== id));
  },
}));

const schedules = { put: [] as { id: string; schedule: Settings['schedule'] }[], deleted: [] as string[], fail: false };
vi.mock('../src/lib/schedules', () => ({
  putDailySchedule: async (id: string, schedule: Settings['schedule']) => {
    if (schedules.fail) throw new Error('scheduler unavailable');
    schedules.put.push({ id, schedule });
  },
  deleteDailySchedule: async (id: string) => void schedules.deleted.push(id),
}));

const invoked: { fn: string; payload: unknown }[] = [];
const stopped: string[] = [];
vi.mock('../src/lib/aws', () => ({
  invokeAsync: async (fn: string, payload: unknown) => void invoked.push({ fn, payload }),
  stopProfileRuns: async (id: string) => (stopped.push(id), id === 'p3' ? 1 : 0),
  startDailyRun: async () => 'arn:exec',
}));
const dataDeleted: string[] = [];
vi.mock('../src/repo/profile-data', () => ({ deleteProfileData: async (id: string) => (dataDeleted.push(id), { items: 3, objects: 1 }) }));
let runs: { status: string; startedAt: string }[] = [];
vi.mock('../src/repo/runs', () => ({ listRuns: async () => runs }));
const usersDeleted: string[] = [];
vi.mock('../src/lib/users', () => ({ deleteUser: async (username: string) => void usersDeleted.push(username) }));
vi.mock('../src/lib/time', async (original) => ({ ...(await original<typeof import('../src/lib/time')>()), sleep: async () => undefined }));

// --- Settings, for the schedule sync ------------------------------------------------------------
let stored: Settings = DEFAULT_SETTINGS;
vi.mock('../src/repo/settings', async (original) => ({
  ...(await original<typeof import('../src/repo/settings')>()),
  getSettings: async () => stored,
  saveSettings: async (_id: string, next: Settings) => (stored = next),
}));
vi.mock('../src/ai/registry', () => ({ configuredProviders: async () => ['anthropic'], languageModel: async () => null }));
vi.mock('../src/repo/telegram', () => ({ listTelegramLinks: async () => [] }));
vi.mock('../src/notify/telegram', () => ({ isTelegramConfigured: async () => false }));

const profiles = (await import('../src/handlers/api/profiles')).handler;
const settings = (await import('../src/handlers/api/settings')).handler;
const worker = (await import('../src/handlers/delete-worker')).handler;

const as = (sub: string, method: string, resource: string, extra: Partial<APIGatewayProxyEvent> = {}) =>
  ({
    httpMethod: method,
    resource,
    headers: {},
    requestContext: { authorizer: { claims: { sub, 'cognito:groups': 'dashboard-users' } } },
    ...extra,
  }) as unknown as APIGatewayProxyEvent;
const profile = (id: string, name: string) => ({ id, name, createdAt: `2026-10-0${id.slice(1)}T00:00:00.000Z` });

beforeEach(() => {
  lists.clear();
  lists.set('u1', [profile('p1', 'Acme'), profile('p3', 'Beta')]);
  lists.set('u2', [profile('p2', 'Colleague desk')]);
  removed.length = 0;
  schedules.put.length = 0;
  schedules.deleted.length = 0;
  schedules.fail = false;
  invoked.length = 0;
  stopped.length = 0;
  dataDeleted.length = 0;
  usersDeleted.length = 0;
  runs = [];
  stored = DEFAULT_SETTINGS;
});

describe('profiles API', () => {
  it("lists the account's own profiles", async () => {
    const res = await profiles(as('u1', 'GET', '/profiles'));
    expect(JSON.parse(res.body).items.map((p: ProfileSummary) => p.name)).toEqual(['Acme', 'Beta']);
  });

  it('creates a blank profile with its daily-run schedule at the default time', async () => {
    const res = await profiles(as('u2', 'POST', '/profiles', { body: JSON.stringify({ name: '  Gamma ' }) }));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ id: 'pnew', name: 'Gamma' });
    expect(schedules.put).toEqual([{ id: 'pnew', schedule: DEFAULT_SETTINGS.schedule }]);
    expect((await profiles(as('u2', 'POST', '/profiles', { body: JSON.stringify({ name: ' ' }) }))).statusCode).toBe(400);
  });

  it("takes a new profile back when its schedule can't be created (it would never run)", async () => {
    schedules.fail = true;
    expect((await profiles(as('u2', 'POST', '/profiles', { body: JSON.stringify({ name: 'Gamma' }) }))).statusCode).toBe(500);
    expect(lists.get('u2')!.map((p) => p.id)).toEqual(['p2']);
    expect(dataDeleted).toEqual(['pnew']);
  });

  it('renames only its own profiles', async () => {
    const res = await profiles(as('u1', 'PATCH', '/profiles/{id}', { pathParameters: { id: 'p3' }, body: JSON.stringify({ name: 'Beta Holdings' }) }));
    expect(JSON.parse(res.body)).toMatchObject({ id: 'p3', name: 'Beta Holdings' });
    expect((await profiles(as('u1', 'PATCH', '/profiles/{id}', { pathParameters: { id: 'p2' }, body: JSON.stringify({ name: 'Mine' }) }))).statusCode).toBe(404);
    expect(lists.get('u2')![0]!.name).toBe('Colleague desk');
  });

  it('deletes a profile: off the list and unscheduled at once, its data handed to the worker', async () => {
    const res = await profiles(as('u1', 'DELETE', '/profiles/{id}', { pathParameters: { id: 'p3' } }));
    expect(res.statusCode).toBe(202);
    expect(lists.get('u1')!.map((p) => p.id)).toEqual(['p1']);
    expect(schedules.deleted).toEqual(['p3']);
    expect(invoked).toEqual([{ fn: 'delete-worker-fn', payload: { profileId: 'p3' } }]);
  });

  it('keeps the last profile, another account\'s profile, and one with a run in progress', async () => {
    expect((await profiles(as('u2', 'DELETE', '/profiles/{id}', { pathParameters: { id: 'p2' } }))).statusCode).toBe(400);
    expect((await profiles(as('u2', 'DELETE', '/profiles/{id}', { pathParameters: { id: 'p1' } }))).statusCode).toBe(404);
    runs = [{ status: 'running', startedAt: new Date().toISOString() }];
    expect((await profiles(as('u1', 'DELETE', '/profiles/{id}', { pathParameters: { id: 'p3' } }))).statusCode).toBe(409);
    // A run that has been "running" for a day is stuck, not in progress.
    runs = [{ status: 'running', startedAt: '2026-01-01T00:00:00.000Z' }];
    expect((await profiles(as('u1', 'DELETE', '/profiles/{id}', { pathParameters: { id: 'p3' } }))).statusCode).toBe(202);
    expect(invoked).toHaveLength(1);
  });
});

describe("a profile's schedule follows its Settings", () => {
  const save = (body: unknown) => settings(as('u1', 'PUT', '/settings', { headers: { 'X-Profile-Id': 'p1' }, body: JSON.stringify(body) }));

  it('moves the schedule when the run time or the on/off switch changes, and only then', async () => {
    expect((await save({ schedule: { dailyTime: '07:30' } })).statusCode).toBe(200);
    expect(schedules.put).toEqual([{ id: 'p1', schedule: { enabled: true, dailyTime: '07:30' } }]);
    await save({ notifications: { notifyWhenEmpty: true } });
    await save({ schedule: { dailyTime: '07:30' } });
    expect(schedules.put).toHaveLength(1);
    await save({ schedule: { enabled: false } });
    expect(schedules.put.at(-1)).toEqual({ id: 'p1', schedule: { enabled: false, dailyTime: '07:30' } });
  });

  it("keeps the old time when the schedule can't be moved", async () => {
    schedules.fail = true;
    expect((await save({ schedule: { dailyTime: '07:30' } })).statusCode).toBe(500);
    expect(stored.schedule.dailyTime).toBe('06:00');
  });
});

describe('delete worker', () => {
  const context = (remainingMs = 10 * 60_000) => ({ functionName: 'delete-worker-fn', getRemainingTimeInMillis: () => remainingMs });

  it("deletes a single profile's data", async () => {
    await worker({ profileId: 'p3' }, context());
    expect(dataDeleted).toEqual(['p3']);
    expect(usersDeleted).toEqual([]);
  });

  it("deletes each of an account's profiles (unscheduled, runs stopped), then the user", async () => {
    await worker({ sub: 'u1', username: 'Google_1' }, context());
    expect(schedules.deleted).toEqual(['p1', 'p3']);
    expect(stopped).toEqual(['p1', 'p3']);
    expect(dataDeleted).toEqual(['p1', 'p3']);
    expect(removed).toEqual(['p1', 'p3']);
    expect(usersDeleted).toEqual(['Google_1']);
  });

  it('hands the remaining profiles to a fresh invocation when time runs low', async () => {
    await worker({ sub: 'u1', username: 'Google_1' }, context(60_000));
    expect(dataDeleted).toEqual([]);
    expect(usersDeleted).toEqual([]);
    expect(invoked).toEqual([{ fn: 'delete-worker-fn', payload: { sub: 'u1', username: 'Google_1' } }]);
  });
});
