import type { Lang } from '@bio-majesty/shared';
import { XMLParser } from 'fast-xml-parser';
import { hashId } from '../lib/ids';
import { addDays, jakartaDate } from '../lib/time';
import { displayTitle, domainOf } from '../lib/url';
import { BROWSER_HEADERS, fetchWithRetry } from './http-fetch';
import type { RawCandidate } from './types';

/**
 * Google News RSS search (free, unofficial). Supports the same operators as
 * the Google News UI: "exact phrase", OR, -exclude, and date operators
 * `when:Nd` / `after:YYYY-MM-DD before:YYYY-MM-DD`. Returns up to ~100 items.
 */
const EDITIONS: Record<Lang, string> = {
  id: 'hl=id&gl=ID&ceid=ID:id',
  en: 'hl=en-ID&gl=ID&ceid=ID:en',
};

export interface GoogleNewsQuery {
  q: string;
  lang: Lang;
  exclude?: string[];
  from: Date;
  to: Date;
  mode: 'when' | 'range';
}

export function buildGoogleNewsQuery(input: Omit<GoogleNewsQuery, 'lang'>): string {
  const parts = [input.q.trim()];
  for (const term of input.exclude ?? []) {
    const t = term.trim();
    if (t) parts.push(/\s/.test(t) ? `-"${t}"` : `-${t}`);
  }
  if (input.mode === 'when') {
    const days = Math.min(7, Math.max(1, Math.ceil((input.to.getTime() - input.from.getTime()) / 86_400_000)));
    parts.push(`when:${days}d`);
  } else {
    // `before:` is exclusive, so add one day to include the window's last day.
    parts.push(`after:${jakartaDate(input.from)}`, `before:${jakartaDate(addDays(input.to, 1))}`);
  }
  return parts.join(' ');
}

export function buildGoogleNewsUrl(input: GoogleNewsQuery): string {
  const q = encodeURIComponent(buildGoogleNewsQuery(input));
  return `https://news.google.com/rss/search?q=${q}&${EDITIONS[input.lang]}`;
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
  meta: { query: string; lang: Lang; categoryId: string },
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

/** Article token from news.google.com/rss/articles/<id> (or /articles/, /read/). */
export function extractGoogleNewsId(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.hostname !== 'news.google.com') return null;
    const match = url.pathname.match(/\/(?:rss\/)?(?:articles|read)\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
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
  return parseGoogleNewsRss(xml, { query: query.q, lang: query.lang, categoryId: query.categoryId });
}
