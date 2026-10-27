import { dateInZone, midnightInZone } from '@bio-majesty/shared';
import { env } from './env';

/** YYYY-MM-DD on the deployment's calendar (TIME_ZONE, default Asia/Singapore). */
export function localDate(date: Date = new Date()): string {
  return dateInZone(env.timeZone, date);
}

/**
 * Parse a YYYY-MM-DD or full ISO string. YYYY-MM-DD is a day in `timeZone`: the
 * deployment's by default (news filters); pass an asset's zone for its trading dates.
 */
export function parseDateInput(value: string, endOfDay = false, timeZone = env.timeZone): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = midnightInZone(timeZone, value);
    return endOfDay ? new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1) : d;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  return d;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export function toEpochSeconds(date: Date | string): number {
  return Math.floor(new Date(date).getTime() / 1000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}
