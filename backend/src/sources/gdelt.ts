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

/** Google operators GDELT has no equivalent for; dropped with their value (and a leading minus). */
const UNSUPPORTED_OPERATOR = /^-?(when|after|before|intitle|inurl|site):/i;

/**
 * Convert a Google-style query into GDELT syntax. GDELT wants OR'd terms in
 * parentheses and accepts parentheses only there, so a bare OR list is wrapped
 * and groups left without an OR (e.g. after dropping site: terms) are unwrapped.
 */
export function toGdeltQuery(q: string, exclude: string[] = []): string | null {
  // Parentheses, "phrases" and words; an operator keeps its value whole (intitle:"a b").
  const tokens = (q.match(/[()]|-?"[^"]*"?|[^\s()"]+(?:"[^"]*"?)?/g) ?? []).filter((t) => !UNSUPPORTED_OPERATOR.test(t));
  const out: string[] = []; // a closed group becomes one token, so '(' only marks open groups
  for (const t of tokens) {
    if (t === 'OR' && (!out.length || out.at(-1) === '(' || out.at(-1) === 'OR')) continue;
    if (t !== ')') {
      out.push(t);
      continue;
    }
    const open = out.lastIndexOf('(');
    if (open < 0) continue;
    const inner = out.splice(open).slice(1);
    if (inner.at(-1) === 'OR') inner.pop();
    if (inner.includes('OR')) out.push(`(${inner.join(' ')})`);
    else out.push(...inner);
  }
  const terms = out.filter((t) => t !== '(');
  while (terms.at(-1) === 'OR') terms.pop();
  if (!terms.length) return null;
  let query = terms.join(' ');
  if (terms.includes('OR') && !terms.some((t) => t.startsWith('('))) query = `(${query})`;
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
  if (!trimmed) return [];
  // GDELT answers a query it can't parse with a plain-text message (and HTTP 200).
  if (!trimmed.startsWith('{')) throw new Error(`GDELT rejected the query: ${trimmed.slice(0, 200)}`);
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
