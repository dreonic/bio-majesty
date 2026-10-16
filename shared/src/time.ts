/**
 * Two clocks:
 *  - the exec's time zone (deployment setting `timeZone`, default Singapore) decides when the
 *    daily run fires, how times are shown and what "today" means for news;
 *  - the market time zone (IDX, Jakarta) decides trading hours and trading dates.
 */

/** The exec's time zone unless the deployment sets another (`timeZone` in backend/cdk.json). */
export const DEFAULT_TIME_ZONE = 'Asia/Singapore';

/** IDX trades on Jakarta time (WIB, UTC+7, no DST): stock schedules and trading dates use it. */
export const MARKET_TIME_ZONE = 'Asia/Jakarta';

/** Abbreviations people use; in English, Intl only offers "GMT+8"-style names for these zones. */
const LABELS: Record<string, string> = {
  'Asia/Singapore': 'SGT',
  'Asia/Jakarta': 'WIB',
  'Asia/Makassar': 'WITA',
  'Asia/Jayapura': 'WIT',
  UTC: 'UTC',
};

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes the zone is ahead of UTC at `date`, e.g. 480 for Singapore. */
export function zoneOffsetMinutes(timeZone: string, date: Date = new Date()): number {
  let format = offsetFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    offsetFormats.set(timeZone, format);
  }
  // "GMT+08:00", or plain "GMT" for UTC.
  const name = format.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

/** YYYY-MM-DD of `date` in the zone. */
export function dateInZone(timeZone: string, date: Date = new Date()): string {
  return new Date(date.getTime() + zoneOffsetMinutes(timeZone, date) * 60_000).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:mm" of `date` in the zone. */
export function dateTimeInZone(timeZone: string, date: Date = new Date()): string {
  return new Date(date.getTime() + zoneOffsetMinutes(timeZone, date) * 60_000).toISOString().slice(0, 16).replace('T', ' ');
}

/** UTC instant of 00:00 on the given YYYY-MM-DD in the zone. */
export function midnightInZone(timeZone: string, ymd: string): Date {
  const utcMidnight = Date.parse(`${ymd}T00:00:00Z`);
  // Second pass corrects zones whose offset changes overnight (DST); a no-op for SGT and WIB.
  let t = utcMidnight - zoneOffsetMinutes(timeZone, new Date(utcMidnight)) * 60_000;
  t = utcMidnight - zoneOffsetMinutes(timeZone, new Date(t)) * 60_000;
  return new Date(t);
}

/** Short display label: "SGT", "WIB", or the offset for other zones, e.g. "GMT+9". */
export function timeZoneLabel(timeZone: string): string {
  const known = LABELS[timeZone];
  if (known) return known;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date());
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}
