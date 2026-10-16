import { describe, expect, it } from 'vitest';
import { dateTimeInZone, stockCsv, type Candle } from '../src';

const bars = (times: string[]): Candle[] =>
  times.map((t, i) => ({ time: Date.parse(t) / 1000, open: 2600 + i, high: 2700, low: 2550.5, close: 2650, volume: 1_234_500 }));

describe('stock CSV download', () => {
  it('writes daily bars oldest first with their trading date and unformatted numbers', () => {
    const out = stockCsv('PRDA.JK', '1d', bars(['2026-10-15T00:00:00Z', '2016-12-09T00:00:00Z']), 'Asia/Singapore');
    expect(out.filename).toBe('PRDA.JK_daily_2016-12-09_2026-10-15.csv');
    expect(out.rows).toBe(2);
    expect(out.csv.split('\r\n')).toEqual([
      'Date,Open,High,Low,Close,Volume',
      '2016-12-09,2601,2700,2550.5,2650,1234500',
      '2026-10-15,2600,2700,2550.5,2650,1234500',
      '',
    ]);
  });

  it("writes 15-minute bars at their start time on the exec's clock", () => {
    // 02:00 UTC = 09:00 in Jakarta = 10:00 in Singapore
    const out = stockCsv('PRDA.JK', '15m', bars(['2026-10-16T02:15:00Z', '2026-10-16T02:00:00Z']), 'Asia/Singapore');
    expect(out.filename).toBe('PRDA.JK_15min_2026-10-16_2026-10-16.csv');
    expect(out.csv.split('\r\n').slice(0, 3)).toEqual([
      'Time (SGT),Open,High,Low,Close,Volume',
      '2026-10-16 10:00,2601,2700,2550.5,2650,1234500',
      '2026-10-16 10:15,2600,2700,2550.5,2650,1234500',
    ]);
    expect(stockCsv('PRDA.JK', '15m', bars(['2026-10-16T02:00:00Z']), 'Asia/Jakarta').csv).toContain('Time (WIB),Open');
  });

  it('names an empty export without dates', () => {
    expect(stockCsv('PRDA.JK', '15m', [], 'Asia/Singapore')).toMatchObject({ filename: 'PRDA.JK_15min.csv', rows: 0 });
  });

  it('formats a date and time in a zone', () => {
    expect(dateTimeInZone('Asia/Singapore', new Date('2026-10-13T16:30:00Z'))).toBe('2026-10-14 00:30');
    expect(dateTimeInZone('Asia/Jakarta', new Date('2026-10-13T16:30:00Z'))).toBe('2026-10-13 23:30');
  });
});
