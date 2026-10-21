import { hashId } from './ids';

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'ocid', 'cmpid',
  'ref', 'ref_src', 'ref_url', 'spm', '_ga', '_gl', 'yclid', 'amp',
]);

/** Remove tracking parameters and fragments; keeps host and path as published. */
export function cleanUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key)) url.searchParams.delete(key);
  }
  if (url.searchParams.get('page') === 'all') url.searchParams.delete('page');
  url.hostname = url.hostname.toLowerCase();
  let out = url.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

/**
 * Canonical form used for de-duplication only: collapses www./m./amp. hosts,
 * trailing /amp segments, trailing slashes and http vs https.
 */
export function canonicalKey(raw: string): string {
  const cleaned = cleanUrl(raw);
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return cleaned.toLowerCase();
  }
  const host = registrableHost(url.hostname);
  let path = url.pathname.replace(/\/amp\/?$/i, '').replace(/\/+$/, '');
  if (path === '') path = '/';
  const query = url.searchParams.toString();
  return `${host}${path}${query ? `?${query}` : ''}`.toLowerCase();
}

/** Hostname without www./m./amp. prefixes (e.g. "m.detik.com" -> "detik.com"). */
export function registrableHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '');
}

export function domainOf(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    return registrableHost(new URL(raw).hostname);
  } catch {
    return null;
  }
}

/**
 * Normalize a headline for de-duplication: drops the " - Source" suffix that
 * Google News appends, punctuation, casing and extra whitespace.
 */
export function normalizeTitle(title: string, sourceName?: string | null): string {
  let t = title.trim();
  if (sourceName) {
    const suffix = ` - ${sourceName}`;
    if (t.toLowerCase().endsWith(suffix.toLowerCase())) t = t.slice(0, -suffix.length);
  }
  return t
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Strip the " - Source" suffix for display. */
export function displayTitle(title: string, sourceName?: string | null): string {
  if (!sourceName) return title.trim();
  const suffix = ` - ${sourceName}`;
  const t = title.trim();
  return t.toLowerCase().endsWith(suffix.toLowerCase()) ? t.slice(0, -suffix.length).trim() : t;
}

export function articleIdForUrl(url: string): string {
  return hashId(canonicalKey(url));
}

export type AliasKind = 'url' | 'gnews' | 'title';

export interface AliasKey {
  kind: AliasKind;
  hash: string;
}

/** All keys under which a candidate can be recognized as already seen. */
export function aliasKeys(input: {
  url?: string | null;
  gnewsId?: string | null;
  title: string;
  sourceName?: string | null;
  sourceDomain?: string | null;
}): AliasKey[] {
  const keys: AliasKey[] = [];
  if (input.url && !isGoogleNewsUrl(input.url)) keys.push({ kind: 'url', hash: hashId(canonicalKey(input.url)) });
  if (input.gnewsId) keys.push({ kind: 'gnews', hash: hashId(input.gnewsId) });
  const norm = normalizeTitle(input.title, input.sourceName);
  if (norm.length >= 12 && input.sourceDomain) {
    keys.push({ kind: 'title', hash: hashId(`${norm}|${registrableHost(input.sourceDomain)}`) });
  }
  return keys;
}

export function isGoogleNewsUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'news.google.com';
  } catch {
    return false;
  }
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
