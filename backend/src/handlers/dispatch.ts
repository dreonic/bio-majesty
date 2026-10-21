import { dateTimeInZone, type Category, type Settings } from '@bio-majesty/shared';
import { listAccounts } from '../lib/accounts';
import { startDailyRun } from '../lib/aws';
import { env } from '../lib/env';
import { errorMessage, logger } from '../lib/logger';
import { listCategories } from '../repo/categories';
import { getSettings } from '../repo/settings';

/** "HH:mm" of the quarter hour `now` falls in, on the deployment's clock. */
export function quarterSlot(now: Date, timeZone: string): { ymd: string; hhmm: string } {
  const local = dateTimeInZone(timeZone, now);
  const minute = Math.floor(Number(local.slice(14, 16)) / 15) * 15;
  return { ymd: local.slice(0, 10), hhmm: `${local.slice(11, 13)}:${String(minute).padStart(2, '0')}` };
}

/** Whether an account's daily run starts in this slot: scheduled now, and something to search for. */
export function isDue(settings: Pick<Settings, 'schedule'>, categories: Pick<Category, 'active' | 'search'>[], slot: { hhmm: string }): boolean {
  if (!settings.schedule.enabled || settings.schedule.dailyTime !== slot.hhmm) return false;
  return categories.some((c) => c.active && c.search.enabled && c.search.queries.length > 0);
}

/**
 * Every 15 minutes: start the daily news run of each account whose run time is this quarter
 * hour. The execution name is unique per account and slot, so a repeated tick can't start a run twice.
 */
export async function handler(): Promise<{ started: number }> {
  const slot = quarterSlot(new Date(), env.timeZone);
  let started = 0;
  for (const { sub } of await listAccounts()) {
    try {
      const [settings, categories] = await Promise.all([getSettings(sub), listCategories(sub)]);
      if (!isDue(settings, categories, slot)) continue;
      await startDailyRun(sub, 'schedule', `daily-${sub}-${slot.ymd.replaceAll('-', '')}${slot.hhmm.replace(':', '')}`);
      started++;
    } catch (err) {
      if ((err as { name?: string }).name === 'ExecutionAlreadyExists') continue;
      logger.error('Could not start a daily run', { sub, error: errorMessage(err) });
    }
  }
  logger.info('Daily runs dispatched', { slot: `${slot.ymd} ${slot.hhmm}`, started });
  return { started };
}
