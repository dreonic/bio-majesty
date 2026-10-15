import { describe, expect, it } from 'vitest';
import { dateInZone, isValidTimeZone, MARKET_TIME_ZONE, midnightInZone, timeZoneLabel, zoneOffsetMinutes } from '../src';

describe('time zones', () => {
  it('knows the offsets of the exec and market zones', () => {
    expect(zoneOffsetMinutes('Asia/Singapore', new Date('2026-10-14T00:00:00Z'))).toBe(480);
    expect(zoneOffsetMinutes(MARKET_TIME_ZONE, new Date('2026-10-14T00:00:00Z'))).toBe(420);
    expect(zoneOffsetMinutes('UTC')).toBe(0);
    expect(zoneOffsetMinutes('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-300);
  });

  it('gives the calendar date in a zone', () => {
    // 16:30 UTC is already the next day in Singapore (UTC+8) but not yet in Jakarta (UTC+7).
    const t = new Date('2026-10-13T16:30:00Z');
    expect(dateInZone('Asia/Singapore', t)).toBe('2026-10-14');
    expect(dateInZone('Asia/Jakarta', t)).toBe('2026-10-13');
  });

  it('finds midnight of a date in a zone', () => {
    expect(midnightInZone('Asia/Singapore', '2026-10-14').toISOString()).toBe('2026-10-13T16:00:00.000Z');
    expect(midnightInZone('Asia/Jakarta', '2026-10-14').toISOString()).toBe('2026-10-13T17:00:00.000Z');
    // New York switches to daylight time on 8 March 2026; midnight that day is still EST (UTC-5).
    expect(midnightInZone('America/New_York', '2026-03-08').toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('labels zones and validates names', () => {
    expect(timeZoneLabel('Asia/Singapore')).toBe('SGT');
    expect(timeZoneLabel('Asia/Jakarta')).toBe('WIB');
    expect(timeZoneLabel('Asia/Tokyo')).toBe('GMT+9');
    expect(isValidTimeZone('Asia/Singapore')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
