/** Formatting helpers. All dates are shown in Asia/Jakarta (WIB). */
const TZ = 'Asia/Jakarta';

const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

export function formatDate(iso: string | number | Date): string {
  return dateFmt.format(new Date(iso));
}

export function formatDateTime(iso: string | number | Date): string {
  return `${dateTimeFmt.format(new Date(iso))} WIB`;
}

export function formatTime(iso: string | number | Date): string {
  return `${timeFmt.format(new Date(iso))} WIB`;
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

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2, signDisplay: 'exceptZero' });

export const formatPrice = (n: number) => intFmt.format(n);
export const formatCompact = (n: number) => compactFmt.format(n);
export const formatPercent = (n: number) => `${pctFmt.format(n)}%`;
export const formatSigned = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${intFmt.format(Math.abs(n))}`;

/** YYYY-MM-DD in Asia/Jakarta for API date filters. */
export function jakartaYmd(date: Date): string {
  return new Date(date.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}
