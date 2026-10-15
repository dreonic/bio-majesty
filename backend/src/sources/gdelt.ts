import type { Lang } from '@bio-majesty/shared';
import { hashId } from '../lib/ids';
import { errorMessage, logger } from '../lib/logger';
import { addDays, sleep } from '../lib/time';
import { cleanUrl, domainOf } from '../lib/url';
import { fetchWithRetry } from './http-fetch';
import type { RawCandidate } from './types';

/**
 * GDELT DOC 2.0 API (free, no key). Covers roughly the last 3 months, returns
 * up to 250 articles per request with publisher URLs, and asks clients to
 * send at most one request every 5 seconds.
 */
export const GDELT_MIN_INTERVAL_MS = 5_500;
export const GDELT_MAX_LOOKBACK_DAYS = 88;

function gdeltStamp(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** Convert a Google-style query into GDELT syntax (drops unsupported operators). */
export function toGdeltQuery(q: string, exclude: string[] = []): string | null {
  let query = q
    .replace(/\b(when|after|before|intitle|inurl|site):\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!query) return null;
  // GDELT requires OR'd terms to be wrapped in parentheses.
  if (/\sOR\s/.test(query) && !/^\(.*\)$/.test(query)) query = `(${query})`;
  for (const term of exclude) {
    const t = term.trim();
    if (t) query += /\s/.test(t) ? ` -"${t}"` : ` -${t}`;
  }
  // GDELT rejects bare keywords shorter than 3 characters.
  if (query.replace(/["()-]/g, '').trim().length < 3) return null;
  return query;
}

export function buildGdeltUrl(query: string, from: Date, to: Date): string {
  const earliest = addDays(new Date(), -GDELT_MAX_LOOKBACK_DAYS);
  const start = from < earliest ? earliest : from;
  const params = new URLSearchParams({
    query,
    mode: 'ArtList',
    format: 'json',
    maxrecords: '250',
    sort: 'DateDesc',
    startdatetime: gdeltStamp(start),
    enddatetime: gdeltStamp(to),
  });
  return `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
}

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
}

export function parseGdeltResponse(
  body: string,
  meta: { query: string; lang: Lang; categoryId: string },
): RawCandidate[] {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return []; // GDELT returns plain-text errors / empty bodies
  let data: { articles?: GdeltArticle[] };
  try {
    data = JSON.parse(trimmed) as { articles?: GdeltArticle[] };
  } catch {
    return [];
  }
  const out: RawCandidate[] = [];
  for (const a of data.articles ?? []) {
    if (!a.url || !a.title) continue;
    const url = cleanUrl(a.url);
    out.push({
      id: hashId(url),
      provider: 'gdelt',
      query: meta.query,
      lang: a.language?.toLowerCase().startsWith('indones') ? 'id' : a.language?.toLowerCase().startsWith('engl') ? 'en' : meta.lang,
      categoryId: meta.categoryId,
      title: a.title.trim(),
      url,
      gnewsId: null,
      sourceName: a.domain ?? null,
      sourceDomain: domainOf(url),
      publishedAt: parseSeenDate(a.seendate),
      snippet: null,
    });
  }
  return out;
}

function parseSeenDate(s?: string): string | null {
  const m = s?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString();
}

/** Run several GDELT queries sequentially, respecting the rate limit. */
export async function searchGdeltSequential(
  queries: { q: string; lang: Lang; categoryId: string; exclude: string[] }[],
  from: Date,
  to: Date,
  deadline: number,
): Promise<{ candidates: RawCandidate[]; errors: number }> {
  const candidates: RawCandidate[] = [];
  let errors = 0;
  for (let i = 0; i < queries.length; i++) {
    if (Date.now() + GDELT_MIN_INTERVAL_MS > deadline) {
      logger.warn('GDELT search stopped early (Lambda deadline)', { done: i, total: queries.length });
      break;
    }
    const item = queries[i]!;
    const query = toGdeltQuery(item.q, item.exclude);
    if (!query) continue;
    try {
      const res = await fetchWithRetry(buildGdeltUrl(query, from, to), { retries: 2, baseDelayMs: 6_000 });
      candidates.push(...parseGdeltResponse(await res.text(), { query: item.q, lang: item.lang, categoryId: item.categoryId }));
    } catch (err) {
      errors++;
      logger.warn('GDELT query failed', { query, error: errorMessage(err) });
    }
    if (i < queries.length - 1) await sleep(GDELT_MIN_INTERVAL_MS);
  }
  return { candidates, errors };
}
