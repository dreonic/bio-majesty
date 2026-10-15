import { sleep } from '../lib/time';

export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
};

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/**
 * fetch() with timeout and retry/backoff on 429 and 5xx. Free/unofficial
 * sources (Google News, GDELT, Yahoo) rate-limit aggressively, so callers
 * should also space out their requests.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15_000, retries = 3, baseDelayMs = 2_000, ...rest } = init;
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const body = await res.text().catch(() => '');
      throw new HttpStatusError(res.status, url, body.slice(0, 500));
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
    await res.body?.cancel().catch(() => undefined);
    await sleep(delay + Math.random() * 500);
    attempt++;
  }
}

export function jitter(minMs: number, maxMs: number): Promise<void> {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}
