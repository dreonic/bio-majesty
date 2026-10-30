import { DEFAULT_SETTINGS, type Category } from '@bio-majesty/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asProfileId } from '../src/repo/keys';

let categories: Category[] = [];
let hasAccess = true;
const created: string[] = [];
vi.mock('../src/repo/categories', () => ({ listCategories: async () => categories, getCategory: async () => null, updateCategory: async () => null }));
vi.mock('../src/repo/settings', () => ({ getSettings: async () => DEFAULT_SETTINGS }));
vi.mock('../src/repo/runs', () => ({
  lastSuccessfulDailyRun: async () => null,
  createRun: async (_profileId: string, run: { id: string }) => void created.push(run.id),
}));
vi.mock('../src/lib/accounts', () => ({ profileHasAccess: async () => hasAccess }));

const { startDaily } = await import('../src/pipeline/start');

const searching: Category = {
  id: 'cat1',
  name: 'Acme',
  description: '',
  color: '#2563eb',
  search: { enabled: true, queries: [{ q: 'acme', edition: 'SG:en' }], exclude: [], sources: { googleNews: true, gdelt: false } },
  backfill: { period: null, status: 'none', runId: null, startedAt: null, completedAt: null, error: null },
  active: true,
  createdAt: '',
  updatedAt: '',
};

beforeEach(() => {
  categories = [];
  hasAccess = true;
  created.length = 0;
});

describe("a profile's daily run", () => {
  const p1 = asProfileId('p1');

  it('runs when the profile has something to search', async () => {
    categories = [searching];
    const state = await startDaily(p1, 'schedule');
    expect(state).toMatchObject({ profileId: 'p1', runType: 'daily', skip: false });
    expect(state.tasks).toHaveLength(1);
    expect(created).toEqual([state.runId]);
  });

  it('ends without a run record when there is nothing to search (a new profile, or a backfill still running)', async () => {
    expect(await startDaily(p1, 'schedule')).toMatchObject({ skip: true, tasks: [] });
    categories = [{ ...searching, active: false }];
    expect((await startDaily(p1, 'manual')).skip).toBe(true);
    expect(created).toEqual([]);
  });

  it("skips a scheduled run once the profile's account has lost access (Run now is checked by the API)", async () => {
    categories = [searching];
    hasAccess = false;
    expect((await startDaily(p1, 'schedule')).skip).toBe(true);
    expect(created).toEqual([]);
    expect((await startDaily(p1, 'manual')).skip).toBe(false);
  });
});
