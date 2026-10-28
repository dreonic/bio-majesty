import { describe, expect, it } from 'vitest';
import { planBackfillPeriods, planMonthsCleanup } from '../src/migrate/backfill-period';

describe('backfill period migration', () => {
  const items = [
    { PK: 'USER#u1', SK: 'CATEGORY#a', backfill: { months: 6, status: 'done' } },
    { PK: 'USER#u1', SK: 'CATEGORY#b', backfill: { months: 0, status: 'none' } },
    { PK: 'USER#u1', SK: 'CATEGORY#c', backfill: { period: { amount: 2, unit: 'weeks' }, status: 'done' } },
    { PK: 'USER#u1', SK: 'SETTINGS', backfill: { months: 3 } },
  ];

  it('turns stored months into a period (0 = no backfill), once', () => {
    expect(planBackfillPeriods(items)).toEqual([
      { key: { PK: 'USER#u1', SK: 'CATEGORY#a' }, period: { amount: 6, unit: 'months' } },
      { key: { PK: 'USER#u1', SK: 'CATEGORY#b' }, period: null },
    ]);
  });

  it('cleans up months only where the period exists', () => {
    const migrated = [{ PK: 'USER#u1', SK: 'CATEGORY#a', backfill: { months: 6, period: { amount: 6, unit: 'months' } } }, ...items];
    expect(planMonthsCleanup(migrated)).toEqual([{ PK: 'USER#u1', SK: 'CATEGORY#a' }]);
  });
});
