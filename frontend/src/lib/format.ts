import { DEFAULT_TIME_ZONE, dateInZone, isValidTimeZone, timeZoneLabel as labelFor, zoneOffsetMinutes } from '@bio-majesty/shared';

/**
 * Formatting helpers. Dates and times are shown in the dashboard's time zone (config.json
 * `timeZone`, default Asia/Singapore), set once at startup by setDisplayTimeZone().
 */
let tz = DEFAULT_TIME_ZONE;
let label = labelFor(tz);
let dateFmt: Intl.DateTimeFormat;
let dateTimeFmt: Intl.DateTimeFormat;
let timeFmt: Intl.DateTimeFormat;

function buildFormats(): void {
  dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' });
  dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
}
buildFormats();

/** Call before the first render; an unknown zone keeps the default. */
export function setDisplayTimeZone(timeZone: string | undefined): void {
  tz = timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  label = labelFor(tz);
  buildFormats();
}

/** IANA name of the display time zone, e.g. "Asia/Singapore". */
export function displayTimeZone(): string {
  return tz;
}

/** Short label of the display time zone, e.g. "SGT". */
export function timeZoneLabel(): string {
  return label;
}

export function formatDate(iso: string | number | Date): string {
  return dateFmt.format(new Date(iso));
}

export function formatDateTime(iso: string | number | Date): string {
  return `${dateTimeFmt.format(new Date(iso))} ${label}`;
}

/** HH:mm without the zone label (for tables whose header names the zone). */
export function formatClock(iso: string | number | Date): string {
  return timeFmt.format(new Date(iso));
}

export function formatTime(iso: string | number | Date): string {
  return `${formatClock(iso)} ${label}`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(iso: string): string {
  const diffSec = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(diffSec / 86_400), 'day');
  return formatDate(iso);
}

const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2, signDisplay: 'exceptZero' });
const priceFmts = new Map<number, Intl.NumberFormat>();

/** Price with the asset's decimals (0 for whole-rupiah IDX stocks, 2 for USD, 4 for most FX). */
function priceFmt(decimals: number): Intl.NumberFormat {
  let fmt = priceFmts.get(decimals);
  if (!fmt) {
    fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    priceFmts.set(decimals, fmt);
  }
  return fmt;
}

export const formatPrice = (n: number, decimals = 0) => priceFmt(decimals).format(n);
export const formatCompact = (n: number) => compactFmt.format(n);
export const formatPercent = (n: number) => `${pctFmt.format(n)}%`;
export const formatSigned = (n: number, decimals = 0) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${priceFmt(decimals).format(Math.abs(n))}`;

/** YYYY-MM-DD in the display time zone, for news date filters. */
export function localYmd(date: Date): string {
  return dateInZone(tz, date);
}

/** Seconds the display time zone is ahead of UTC at a UNIX time (shifts intraday chart bars). */
export function displayOffsetSeconds(unixSeconds: number): number {
  return zoneOffsetMinutes(tz, new Date(unixSeconds * 1000)) * 60;
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}
