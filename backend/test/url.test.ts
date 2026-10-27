import { describe, expect, it } from 'vitest';
import {
  aliasKeys,
  canonicalKey,
  cleanUrl,
  displayTitle,
  domainOf,
  isGoogleNewsUrl,
  normalizeTitle,
} from '../src/lib/url';

describe('cleanUrl', () => {
  it('drops tracking parameters and fragments', () => {
    expect(cleanUrl('https://Kontan.co.id/news/abc?utm_source=x&utm_medium=y&id=5#top')).toBe('https://kontan.co.id/news/abc?id=5');
    expect(cleanUrl('https://x.com/a?fbclid=123')).toBe('https://x.com/a');
  });

  it('removes page=all (Kompas "show all")', () => {
    expect(cleanUrl('https://money.kompas.com/read/2026/10/01/x?page=all')).toBe('https://money.kompas.com/read/2026/10/01/x');
  });
});

describe('canonicalKey', () => {
  it('collapses www/m/amp hosts, /amp suffix, trailing slash and protocol', () => {
    const a = canonicalKey('https://www.detik.com/finance/berita/123/judul/');
    const b = canonicalKey('http://m.detik.com/finance/berita/123/judul/amp');
    expect(a).toBe(b);
    expect(a).toBe('detik.com/finance/berita/123/judul');
  });
});

describe('titles', () => {
  it('strips the Google News source suffix', () => {
    expect(displayTitle('Laba Acme Naik 10% - Kontan', 'Kontan')).toBe('Laba Acme Naik 10%');
    expect(displayTitle('Laba Acme Naik', null)).toBe('Laba Acme Naik');
  });

  it('normalizes punctuation, accents and case', () => {
    expect(normalizeTitle('  Acme (ACME) Bagikan Dividen!  - Bisnis.com', 'Bisnis.com')).toBe('acme acme bagikan dividen');
  });
});

describe('aliasKeys', () => {
  it('uses url + title keys for publisher URLs', () => {
    const keys = aliasKeys({ url: 'https://kontan.co.id/a', title: 'Acme membuka klinik baru di Medan', sourceDomain: 'www.kontan.co.id' });
    expect(keys.map((k) => k.kind)).toEqual(['url', 'title']);
  });

  it('never uses a Google News link as the url key', () => {
    const keys = aliasKeys({
      url: 'https://news.google.com/rss/articles/CBMiabc?oc=5',
      gnewsId: 'CBMiabc',
      title: 'Acme membuka klinik baru di Medan',
      sourceDomain: 'kontan.co.id',
    });
    expect(keys.map((k) => k.kind)).toEqual(['gnews', 'title']);
  });

  it('matches the same headline from Google News and GDELT', () => {
    const fromGoogle = aliasKeys({ title: 'Acme membuka klinik baru di Medan - Kontan', sourceName: 'Kontan', sourceDomain: 'www.kontan.co.id' });
    const fromGdelt = aliasKeys({ url: 'https://kontan.co.id/x', title: 'Acme membuka klinik baru di Medan', sourceDomain: 'kontan.co.id' });
    const titleKey = (ks: typeof fromGoogle) => ks.find((k) => k.kind === 'title')?.hash;
    expect(titleKey(fromGoogle)).toBe(titleKey(fromGdelt));
  });
});

describe('misc', () => {
  it('detects Google News URLs and domains', () => {
    expect(isGoogleNewsUrl('https://news.google.com/rss/articles/x')).toBe(true);
    expect(isGoogleNewsUrl('https://kontan.co.id')).toBe(false);
    expect(domainOf('https://www.cnbcindonesia.com/market/123')).toBe('cnbcindonesia.com');
    expect(domainOf('not a url')).toBeNull();
  });
});
