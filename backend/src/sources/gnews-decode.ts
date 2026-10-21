import { logger } from '../lib/logger';
import { extractGoogleNewsId } from '../lib/url';
import { BROWSER_HEADERS, fetchWithRetry, jitter } from './http-fetch';

/**
 * Resolve Google News redirect links (news.google.com/rss/articles/<id>) to
 * publisher URLs. Port of the approach used by the `googlenewsdecoder` Python
 * package: older ids embed the URL in base64; newer ones need the signature
 * and timestamp from the article page, then a `batchexecute` call.
 *
 * This is unofficial and may break if Google changes its pages; callers keep
 * the Google link when decoding fails.
 */

const BATCH_EXECUTE = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';

/** Old-style ids: base64 protobuf containing the URL as plain text. */
export function decodeLegacyId(id: string): string | null {
  try {
    const bytes = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const text = bytes.toString('latin1');
    const match = text.match(/https?:\/\/[\x21-\x7e]+/);
    if (!match) return null;
    // Strip trailing protobuf bytes that can follow the URL.
    return match[0].replace(/[\x00-\x1f\x7f-\xff].*$/, '');
  } catch {
    return null;
  }
}

export interface DecodeParams {
  id: string;
  signature: string;
  timestamp: string;
}

export function extractDecodeParams(html: string, id: string): DecodeParams | null {
  const sg = html.match(/data-n-a-sg="([^"]+)"/);
  const ts = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sg?.[1] || !ts?.[1]) return null;
  return { id, signature: sg[1], timestamp: ts[1] };
}

export function buildBatchExecuteBody(params: DecodeParams[]): string {
  const reqs = params.map((p) => [
    'Fbv4je',
    `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${p.id}",${p.timestamp},"${p.signature}"]`,
  ]);
  return `f.req=${encodeURIComponent(JSON.stringify([reqs]))}`;
}

export function parseBatchExecuteResponse(text: string): string[] {
  const payload = text.split('\n\n')[1];
  if (!payload) return [];
  const rows = JSON.parse(payload) as unknown[][];
  const urls: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row[0] !== 'wrb.fr' || typeof row[2] !== 'string') continue;
    try {
      const inner = JSON.parse(row[2]) as unknown[];
      if (typeof inner[1] === 'string' && /^https?:\/\//.test(inner[1])) urls.push(inner[1]);
    } catch {
      // ignore malformed rows
    }
  }
  return urls;
}

async function fetchDecodeParams(id: string): Promise<DecodeParams | null> {
  for (const base of ['https://news.google.com/articles/', 'https://news.google.com/rss/articles/']) {
    try {
      const res = await fetchWithRetry(`${base}${id}`, { headers: BROWSER_HEADERS, retries: 1 });
      const params = extractDecodeParams(await res.text(), id);
      if (params) return params;
    } catch (err) {
      logger.debug('Decode params fetch failed', { base, err: String(err) });
    }
  }
  return null;
}

/** Decode one Google News link; returns null when it cannot be resolved. */
export async function decodeGoogleNewsUrl(link: string): Promise<string | null> {
  const id = extractGoogleNewsId(link);
  if (!id) return null;
  const legacy = decodeLegacyId(id);
  if (legacy) return legacy;

  const params = await fetchDecodeParams(id);
  if (!params) return null;
  await jitter(300, 900);
  const res = await fetchWithRetry(BATCH_EXECUTE, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: buildBatchExecuteBody([params]),
    retries: 2,
  });
  const urls = parseBatchExecuteResponse(await res.text());
  return urls[0] ?? null;
}
