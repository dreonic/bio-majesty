import { describe, expect, it, vi } from 'vitest';
import { buildGdeltUrl, GDELT_MAX_LOOKBACK_DAYS, parseGdeltResponse, toGdeltQuery } from '../src/sources/gdelt';
import {
  buildBatchExecuteBody,
  decodeLegacyId,
  extractDecodeParams,
  parseBatchExecuteResponse,
} from '../src/sources/gnews-decode';
import {
  buildGoogleNewsQuery,
  buildGoogleNewsUrl,
  extractGoogleNewsId,
  parseGoogleNewsRss,
} from '../src/sources/google-news-rss';
import { backfillWindowDays, planWindows } from '../src/sources/windows';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>"prodia" - Google News</title>
<item>
  <title>Prodia (PRDA) Raih Laba Rp 206 Miliar - Investortrust</title>
  <link>https://news.google.com/rss/articles/CBMiTEST123?oc=5</link>
  <guid isPermaLink="false">CBMiTEST123</guid>
  <pubDate>Mon, 13 Oct 2026 03:15:00 GMT</pubDate>
  <description>&lt;a href="https://news.google.com/rss/articles/CBMiTEST123?oc=5"&gt;Prodia&lt;/a&gt;</description>
  <source url="https://investortrust.id">Investortrust</source>
</item>
<item>
  <title>Saham PRDA &amp; Kesehatan - Kontan</title>
  <link>https://news.google.com/rss/articles/CBMiSECOND?oc=5</link>
  <pubDate>Sun, 12 Oct 2026 10:00:00 GMT</pubDate>
  <source url="https://www.kontan.co.id">Kontan</source>
</item>
</channel></rss>`;

describe('Google News RSS', () => {
  it('builds relative-window queries with exclusions', () => {
    const q = buildGoogleNewsQuery({
      q: '"Prodia Widyahusada"',
      exclude: ['prodia.com', 'image generation'],
      from: new Date('2026-10-13T00:00:00Z'),
      to: new Date('2026-10-14T00:00:00Z'),
      mode: 'when',
    });
    expect(q).toBe('"Prodia Widyahusada" -prodia.com -"image generation" when:1d');
  });

  it("builds absolute date ranges on the deployment's calendar (before: is exclusive)", () => {
    const window = { q: 'PRDA', from: new Date('2026-09-01T00:00:00+08:00'), to: new Date('2026-09-14T08:00:00+08:00'), mode: 'range' as const };
    vi.stubEnv('TIME_ZONE', 'Asia/Singapore');
    expect(buildGoogleNewsQuery(window)).toBe('PRDA after:2026-09-01 before:2026-09-15');
    vi.stubEnv('TIME_ZONE', 'America/New_York');
    expect(buildGoogleNewsQuery(window)).toBe('PRDA after:2026-08-31 before:2026-09-14');
    vi.unstubAllEnvs();
  });

  it("searches the query's edition", () => {
    const base = { q: 'prodia', from: new Date(), to: new Date(), mode: 'when' as const };
    expect(buildGoogleNewsUrl({ ...base, edition: 'ID:id' })).toContain('&hl=id&gl=ID&ceid=ID:id');
    expect(buildGoogleNewsUrl({ ...base, edition: 'ID:en' })).toContain('&hl=en-ID&gl=ID&ceid=ID:en');
    expect(buildGoogleNewsUrl({ ...base, edition: 'SG:en' })).toContain('&hl=en-SG&gl=SG&ceid=SG:en');
    expect(buildGoogleNewsUrl({ ...base, edition: 'CN:zh-Hans' })).toContain('&hl=zh-CN&gl=CN&ceid=CN:zh-Hans');
  });

  it('parses items, strips the source suffix and keeps the article token', () => {
    const items = parseGoogleNewsRss(RSS, { query: 'prodia', lang: 'id', categoryId: 'cat1' });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Prodia (PRDA) Raih Laba Rp 206 Miliar',
      sourceName: 'Investortrust',
      sourceDomain: 'investortrust.id',
      gnewsId: 'CBMiTEST123',
      publishedAt: '2026-10-13T03:15:00.000Z',
      provider: 'gnews',
      categoryId: 'cat1',
    });
    expect(items[1]!.title).toBe('Saham PRDA & Kesehatan');
    expect(items[1]!.sourceDomain).toBe('kontan.co.id');
  });

  it('extracts article ids from the different link shapes', () => {
    expect(extractGoogleNewsId('https://news.google.com/rss/articles/ABC?oc=5')).toBe('ABC');
    expect(extractGoogleNewsId('https://news.google.com/articles/DEF')).toBe('DEF');
    expect(extractGoogleNewsId('https://news.google.com/read/GHI')).toBe('GHI');
    expect(extractGoogleNewsId('https://kontan.co.id/x')).toBeNull();
  });
});

describe('Google News decoding', () => {
  it('reads signature and timestamp from the article page', () => {
    const html = '<c-wiz><div jscontroller="x" data-n-a-sg="SIG_abc" data-n-a-ts="1760000000"></div></c-wiz>';
    expect(extractDecodeParams(html, 'ID1')).toEqual({ id: 'ID1', signature: 'SIG_abc', timestamp: '1760000000' });
    expect(extractDecodeParams('<html></html>', 'ID1')).toBeNull();
  });

  it('builds the batchexecute form body', () => {
    const body = buildBatchExecuteBody([{ id: 'ID1', signature: 'SIG', timestamp: '17' }]);
    expect(body.startsWith('f.req=')).toBe(true);
    const decoded = JSON.parse(decodeURIComponent(body.slice('f.req='.length)));
    expect(decoded[0][0][0]).toBe('Fbv4je');
    expect(decoded[0][0][1]).toContain('"ID1",17,"SIG"');
  });

  it('parses the batchexecute response', () => {
    const text = `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.kontan.co.id/news/prodia\\",1]",null,null,null,"generic"],["di",42],["af.httprm",42,"1",9]]`;
    expect(parseBatchExecuteResponse(text)).toEqual(['https://www.kontan.co.id/news/prodia']);
  });

  it('decodes legacy base64 ids that embed the URL', () => {
    const id = Buffer.from('\x08\x13"\x1fhttps://kontan.co.id/news/abc\xd2\x01\x00').toString('base64url');
    expect(decodeLegacyId(id)).toBe('https://kontan.co.id/news/abc');
    expect(decodeLegacyId('CBMiAU_yqLOpaque')).toBeNull();
  });
});

describe('GDELT', () => {
  it('converts Google-style queries', () => {
    expect(toGdeltQuery('"Prodia Widyahusada" OR PRDA when:1d', ['prodia.com'])).toBe('("Prodia Widyahusada" OR PRDA) -prodia.com');
    expect(toGdeltQuery('site:kontan.co.id')).toBeNull();
    expect(toGdeltQuery('ab')).toBeNull();
  });

  it('keeps parentheses only around OR lists', () => {
    expect(toGdeltQuery('prodia OR PRDA')).toBe('(prodia OR PRDA)');
    expect(toGdeltQuery('prodia (laba OR dividen)')).toBe('prodia (laba OR dividen)');
    expect(toGdeltQuery('(prodia OR PRDA) (laba OR dividen) -bni')).toBe('(prodia OR PRDA) (laba OR dividen) -bni');
    expect(toGdeltQuery('"Prodia OR x"')).toBe('"Prodia OR x"');
    expect(toGdeltQuery('(prodia)')).toBe('prodia');
  });

  it('drops unsupported operators without leaving broken syntax behind', () => {
    expect(toGdeltQuery('prodia -site:example.com')).toBe('prodia');
    expect(toGdeltQuery('(site:instagram.com OR site:x.com) prodia')).toBe('prodia');
    expect(toGdeltQuery('(prodia OR site:x.com/prodia) saham')).toBe('prodia saham');
    expect(toGdeltQuery('intitle:"Prodia Widyahusada" OR PRDA')).toBe('PRDA');
    expect(toGdeltQuery('prodia OR when:7d')).toBe('prodia');
    expect(toGdeltQuery('intitle:prodia intitle:saham')).toBeNull();
  });

  it('clamps the start date to the ~3 month horizon', () => {
    const url = new URL(buildGdeltUrl('prodia', new Date('2020-01-01T00:00:00Z'), new Date()));
    const start = url.searchParams.get('startdatetime')!;
    const startDate = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z`);
    const ageDays = (Date.now() - startDate.getTime()) / 86_400_000;
    expect(ageDays).toBeLessThanOrEqual(GDELT_MAX_LOOKBACK_DAYS + 1);
  });

  it('parses articles and throws on plain-text error bodies', () => {
    const body = JSON.stringify({
      articles: [
        { url: 'https://www.bisnis.com/a?utm_source=x', title: 'Prodia ekspansi', seendate: '20261013T081500Z', domain: 'bisnis.com', language: 'Indonesian' },
        { url: 'https://example.com/b', title: '' },
      ],
    });
    const items = parseGdeltResponse(body, { query: 'prodia', lang: 'en', categoryId: 'c' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ url: 'https://www.bisnis.com/a', lang: 'id', publishedAt: '2026-10-13T08:15:00.000Z', sourceDomain: 'bisnis.com' });
    const meta = { query: 'q', lang: 'id', categoryId: 'c' } as const;
    expect(() => parseGdeltResponse("Parentheses may only be used around OR'd statements.", meta)).toThrow(/Parentheses may only/);
    expect(parseGdeltResponse('', meta)).toEqual([]);
  });
});

describe('backfill windows', () => {
  it('covers the whole range newest-first without gaps', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-03-01T00:00:00Z');
    const windows = planWindows(from, to, 14);
    expect(windows[0]!.to).toEqual(to);
    expect(windows[windows.length - 1]!.from).toEqual(from);
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.to).toEqual(windows[i - 1]!.from);
  });

  it('widens windows for long periods', () => {
    expect(backfillWindowDays(1)).toBe(7);
    expect(backfillWindowDays(6)).toBe(14);
    expect(backfillWindowDays(24)).toBe(30);
  });
});
