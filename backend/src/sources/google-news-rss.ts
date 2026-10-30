import { EDITIONS, type Edition } from '@bio-majesty/shared';
import { XMLParser } from 'fast-xml-parser';
import { hashId } from '../lib/ids';
import { addDays, localDate } from '../lib/time';
import { displayTitle, domainOf, extractGoogleNewsId } from '../lib/url';
import { BROWSER_HEADERS, fetchWithRetry } from './http-fetch';
import type { RawCandidate } from './types';

export { extractGoogleNewsId };

/**
 * Google News RSS search (free, unofficial). Supports the same operators as
 * the Google News UI: "exact phrase", OR, -exclude, and date operators
 * `when:1d` / `after:YYYY-MM-DD before:YYYY-MM-DD`. Returns up to ~100 items.
 */
export interface GoogleNewsQuery {
  q: string;
  edition: Edition;
  exclude?: string[];
  from: Date;
  to: Date;
  /** 'when' = the 24 hours before the request; 'range' = the days from `from` to `to`. */
  mode: 'when' | 'range';
}

export function buildGoogleNewsQuery(input: Omit<GoogleNewsQuery, 'edition'>): string {
  const parts = [input.q.trim()];
  for (const term of input.exclude ?? []) {
    const t = term.trim();
    if (t) parts.push(/\s/.test(t) ? `-"${t}"` : `-${t}`);
  }
  if (input.mode === 'when') {
    // Never more than a day: longer relative windows return fewer of the latest items (see dailyGoogleNewsWindows).
    parts.push('when:1d');
  } else {
    // `before:` is exclusive, so add one day to include the window's last day. Days on the
    // deployment's clock: windows overlap by a day, so publishers in other zones lose nothing.
    parts.push(`after:${localDate(input.from)}`, `before:${localDate(addDays(input.to, 1))}`);
  }
  return parts.join(' ');
}

/** An edition's query parameters, e.g. "hl=id&gl=ID&ceid=ID:id". */
export function editionParams(edition: Edition): string {
  return `hl=${EDITIONS[edition].hl}&gl=${edition.slice(0, edition.indexOf(':'))}&ceid=${edition}`;
}

export function buildGoogleNewsUrl(input: GoogleNewsQuery): string {
  const q = encodeURIComponent(buildGoogleNewsQuery(input));
  return `https://news.google.com/rss/search?q=${q}&${editionParams(input.edition)}`;
}

interface RssItem {
  title?: string;
  link?: string;
  guid?: string | { '#text'?: string };
  pubDate?: string;
  description?: string;
  source?: string | { '#text'?: string; '@_url'?: string };
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: true });

export function parseGoogleNewsRss(
  xml: string,
  meta: { query: string; lang: string; categoryId: string },
): RawCandidate[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
  const rawItems = doc.rss?.channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  const out: RawCandidate[] = [];
  for (const item of items) {
    const link = typeof item.link === 'string' ? item.link.trim() : '';
    const rawTitle = typeof item.title === 'string' ? item.title : '';
    if (!link || !rawTitle) continue;
    const sourceName = typeof item.source === 'object' ? (item.source['#text'] ?? null) : (item.source ?? null);
    const sourceUrl = typeof item.source === 'object' ? (item.source['@_url'] ?? null) : null;
    const gnewsId = extractGoogleNewsId(link);
    const published = item.pubDate ? new Date(item.pubDate) : null;
    out.push({
      id: hashId(gnewsId ?? link),
      provider: 'gnews',
      query: meta.query,
      lang: meta.lang,
      categoryId: meta.categoryId,
      title: displayTitle(decodeEntities(rawTitle), sourceName),
      url: link,
      gnewsId,
      sourceName: sourceName ? decodeEntities(sourceName) : null,
      sourceDomain: domainOf(sourceUrl),
      publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
      snippet: null,
    });
  }
  return out;
}


function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export async function searchGoogleNews(
  query: GoogleNewsQuery & { categoryId: string },
): Promise<RawCandidate[]> {
  const res = await fetchWithRetry(buildGoogleNewsUrl(query), {
    headers: { ...BROWSER_HEADERS, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
  });
  const xml = await res.text();
  return parseGoogleNewsRss(xml, { query: query.q, lang: EDITIONS[query.edition].lang, categoryId: query.categoryId });
}
