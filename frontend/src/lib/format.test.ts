import { describe, expect, it } from 'vitest';
import { formatCompact, formatPercent, formatPrice, formatSigned, jakartaYmd } from './format';
import { buildUrl, configureApi } from './api';

describe('format helpers', () => {
  it('formats prices, signed changes, percents and volumes', () => {
    expect(formatPrice(3145.6)).toBe('3,146');
    expect(formatSigned(55)).toBe('+55');
    expect(formatSigned(-55)).toBe('−55');
    expect(formatPercent(1.7834)).toBe('+1.78%');
    expect(formatCompact(2_250_000)).toBe('2.3M');
  });

  it('converts to the Asia/Jakarta calendar date', () => {
    // 18:00 UTC is already the next day in Jakarta (UTC+7)
    expect(jakartaYmd(new Date('2026-10-13T18:00:00Z'))).toBe('2026-10-14');
    expect(jakartaYmd(new Date('2026-10-13T10:00:00Z'))).toBe('2026-10-13');
  });
});

describe('api urls', () => {
  it('joins paths and serializes array query params', () => {
    configureApi({ baseUrl: 'https://api.example.com/api/', getToken: () => undefined, onUnauthorized: () => undefined });
    expect(buildUrl('news', { status: 'APPROVED', categories: ['a', 'b'], q: '', cursor: undefined })).toBe(
      'https://api.example.com/api/news?status=APPROVED&categories=a%2Cb',
    );
  });
});
