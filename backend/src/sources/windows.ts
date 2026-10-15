import { addDays } from '../lib/time';

export interface DateWindow {
  from: Date;
  to: Date;
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

/** Window size for a backfill: longer periods use wider windows to cap request counts. */
export function backfillWindowDays(months: number): number {
  if (months <= 3) return 7;
  if (months <= 12) return 14;
  return 30;
}
