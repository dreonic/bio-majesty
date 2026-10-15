import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { assertPublicHttpUrl } from '../lib/ssrf';
import { cleanUrl } from '../lib/url';
import { BROWSER_HEADERS } from '../sources/http-fetch';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_TEXT_CHARS = 30_000;
/** Below this, the page is most likely a paywall, consent wall or error page. */
const MIN_ARTICLE_CHARS = 500;

export interface ExtractedArticle {
  finalUrl: string;
  status: 'ok' | 'paywalled' | 'failed';
  title: string | null;
  text: string | null;
  excerpt: string | null;
  siteName: string | null;
  publishedTime: string | null;
  lang: string | null;
  error: string | null;
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const charset = res.headers.get('content-type')?.match(/charset=([^;]+)/i)?.[1]?.trim() ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(Buffer.concat(chunks));
}

/** Fetch a page following redirects manually so every hop passes the SSRF guard. */
export async function fetchHtml(url: string, timeoutMs = 12_000): Promise<{ finalUrl: string; html: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`Redirect without location from ${current}`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${res.status}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (type && !/html|xml/i.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Unsupported content type ${type}`);
    }
    return { finalUrl: current, html: await readLimited(res) };
  }
  throw new Error('Too many redirects');
}

export function extractFromHtml(html: string): Omit<ExtractedArticle, 'finalUrl' | 'error'> {
  const { document } = parseHTML(html);
  const parsed = new Readability(document as unknown as Document, { charThreshold: 300 }).parse();
  const text = normalizeWhitespace(parsed?.textContent ?? '');
  const lang = (document.documentElement?.getAttribute('lang') ?? parsed?.lang ?? null) || null;
  const metaPublished =
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ??
    document.querySelector('meta[name="pubdate"]')?.getAttribute('content') ??
    null;
  return {
    status: text.length >= MIN_ARTICLE_CHARS ? 'ok' : 'paywalled',
    title: parsed?.title?.trim() || null,
    text: text ? text.slice(0, MAX_TEXT_CHARS) : null,
    excerpt: parsed?.excerpt?.trim() || null,
    siteName: parsed?.siteName?.trim() || null,
    publishedTime: parsed?.publishedTime ?? metaPublished,
    lang,
  };
}

export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export async function fetchArticle(url: string): Promise<ExtractedArticle> {
  try {
    const { finalUrl, html } = await fetchHtml(url);
    return { finalUrl: cleanUrl(finalUrl), error: null, ...extractFromHtml(html) };
  } catch (err) {
    return {
      finalUrl: url,
      status: 'failed',
      title: null,
      text: null,
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
