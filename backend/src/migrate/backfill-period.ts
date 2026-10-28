/**
 * Categories stored with `backfill.months` get `backfill.period` (months as a period, 0 = null), used
 * by scripts/migrate-backfill-period.ts. Pure: no AWS calls.
 */
import type { BackfillPeriod } from '@bio-majesty/shared';

export type Item = Record<string, unknown>;

export interface PeriodUpdate {
  key: { PK: string; SK: string };
  period: BackfillPeriod | null;
}

const isCategory = (i: Item) => String(i.PK).startsWith('USER#') && String(i.SK).startsWith('CATEGORY#');
const backfillOf = (i: Item) => (i.backfill ?? {}) as Record<string, unknown>;

/** Categories without a period yet, with the period their stored months mean. */
export function planBackfillPeriods(items: Item[]): PeriodUpdate[] {
  return items
    .filter((i) => isCategory(i) && !('period' in backfillOf(i)))
    .map((i) => {
      const months = Number(backfillOf(i).months ?? 0);
      return { key: { PK: String(i.PK), SK: String(i.SK) }, period: months > 0 ? { amount: months, unit: 'months' } : null };
    });
}

/** Categories that have a period and still carry the old `months` (removed by --cleanup). */
export function planMonthsCleanup(items: Item[]): { PK: string; SK: string }[] {
  return items
    .filter((i) => isCategory(i) && 'period' in backfillOf(i) && 'months' in backfillOf(i))
    .map((i) => ({ PK: String(i.PK), SK: String(i.SK) }));
}
