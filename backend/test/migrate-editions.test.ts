import { describe, expect, it } from 'vitest';
import { planEditionMigration, planLangCleanup } from '../src/migrate/editions';

const search = (queries: object[]) => ({ enabled: true, queries, exclude: [], sources: { googleNews: true, gdelt: true } });

/** A table as stored before editions. */
const before = [
  { PK: 'USER#u1', SK: 'CATEGORY#c1', name: 'Acme Group', search: search([{ q: '"Acme Group"', lang: 'id' }, { q: 'Acme Group results', lang: 'en' }]) },
  { PK: 'USER#u1', SK: 'CATEGORY#c2', name: 'Already done', search: search([{ q: 'acme', lang: 'en', edition: 'SG:en' }]) },
  { PK: 'USER#u1', SK: 'SETTINGS', data: { profile: { subject: 'Acme Group', context: '', sentimentAsset: null }, stock: { assets: [] } } },
  { PK: 'USER#u2', SK: 'CATEGORY#c3', name: 'Label only', search: { enabled: false, queries: [], exclude: [], sources: { googleNews: true, gdelt: true } } },
  { PK: 'USER#u3', SK: 'CATEGORY#c4', name: 'Beta', search: search([{ q: 'beta', lang: 'id' }]) },
  { PK: 'USER#u3', SK: 'SETTINGS', data: { schedule: { enabled: true, dailyTime: '06:00' } } },
  { PK: 'USER#u4', SK: 'SETTINGS', data: { schedule: { enabled: false, dailyTime: '07:00' } } },
];

describe('migration to editions', () => {
  const plan = planEditionMigration(before);

  it('gives each query the Google News Indonesia edition of its language, keeping the language for the old version', () => {
    expect(plan.puts).toEqual([
      { ...before[0], search: search([{ q: '"Acme Group"', lang: 'id', edition: 'ID:id' }, { q: 'Acme Group results', lang: 'en', edition: 'ID:en' }]) },
      { ...before[4], search: search([{ q: 'beta', lang: 'id', edition: 'ID:id' }]) },
    ]);
    expect(plan.replaced).toEqual([before[0], before[4]]);
    expect(plan.counts).toEqual({ categories: 2, queries: 3 });
  });

  it('lists accounts with categories whose profile or assets came from the defaults', () => {
    // u2 has no settings at all, u3 never saved a profile; u4 has no categories, so it is new anyway.
    expect(plan.onDefaults).toEqual(['u2', 'u3']);
  });

  it('is idempotent', () => {
    const after = before.map((i) => plan.puts.find((p) => p.PK === i.PK && p.SK === i.SK) ?? i);
    expect(planEditionMigration(after).puts).toEqual([]);
  });

  it('cleans up: drops the language from queries that have an edition', () => {
    const after = before.map((i) => plan.puts.find((p) => p.PK === i.PK && p.SK === i.SK) ?? i);
    expect(planLangCleanup(after)).toEqual([
      { ...before[0], search: search([{ q: '"Acme Group"', edition: 'ID:id' }, { q: 'Acme Group results', edition: 'ID:en' }]) },
      { ...before[1], search: search([{ q: 'acme', edition: 'SG:en' }]) },
      { ...before[4], search: search([{ q: 'beta', edition: 'ID:id' }]) },
    ]);
    // A query without an edition keeps its language: the cleanup never runs ahead of the migration.
    expect(planLangCleanup(before).map((i) => i.SK)).toEqual(['CATEGORY#c2']);
  });
});
