import { addDays, localDate, parseDateInput } from '../lib/time';

export interface DateWindow {
  from: Date;
  to: Date;
}

/** A Google News search window: the last 24 hours ('when') or whole days ('range'). */
export interface SearchWindow extends DateWindow {
  mode: 'when' | 'range';
}

/** How far past a day a daily window may reach and still be searched as just the last day. */
export const DAILY_SLACK_MS = 30 * 60 * 1000;

/** Every date on the deployment's calendar from the day of `from` to the day of `to`. */
export function calendarDays(from: Date, to: Date): string[] {
  const days: string[] = [];
  const last = localDate(to);
  for (let ymd = localDate(from); ymd <= last; ymd = nextDay(ymd)) days.push(ymd);
  return days;
}

function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Google News searches for a daily run's window. Google returns a different, smaller selection
 * for any window longer than a day and loses much of the latest day (tested 2026-10-30: `when:2d`
 * kept 15 of the 48 items `when:1d` found, and a two-day after:/before: range about half of each
 * day's), so the last 24 hours are one `when:1d` search and an older part (after a failed run, an
 * outage or a changed run time) is searched one calendar day at a time. Up to DAILY_SLACK_MS past
 * a day counts as the last day alone; GDELT, which searches the exact window, covers those minutes.
 */
export function dailyGoogleNewsWindows(from: Date, to: Date): SearchWindow[] {
  const lastDay: SearchWindow = { from: addDays(to, -1), to, mode: 'when' };
  if (to.getTime() - from.getTime() <= 86_400_000 + DAILY_SLACK_MS) return [lastDay];
  // From a day early, in case Google reads the dates in another time zone.
  const older = calendarDays(addDays(from, -1), lastDay.from).map((ymd): SearchWindow => ({
    from: parseDateInput(ymd),
    to: parseDateInput(ymd, true),
    mode: 'range',
  }));
  return [lastDay, ...older];
}

/**
 * Split [from, to] into consecutive windows of `days` days, newest first.
 * Smaller windows mean more requests but better recall, because Google News
 * returns at most ~100 results per query.
 */
export function planWindows(from: Date, to: Date, days: number): DateWindow[] {
  if (days <= 0) throw new Error('days must be positive');
  const windows: DateWindow[] = [];
  let end = to;
  while (end > from) {
    const start = addDays(end, -days);
    windows.push({ from: start < from ? from : start, to: end });
    end = start;
  }
  return windows;
}

/** Window size for a backfill of `days` days: longer periods use wider windows to cap request counts. */
export function backfillWindowDays(days: number): number {
  if (days <= 92) return 7;
  if (days <= 366) return 14;
  return 30;
}
