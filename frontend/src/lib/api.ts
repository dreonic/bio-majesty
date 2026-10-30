import { PROFILE_HEADER } from '@bio-majesty/shared';

/**
 * Thin fetch wrapper for the dashboard API. The Cognito ID token is supplied
 * by the auth layer through `configureApi`; the profile requests work on, by
 * the profile layer through `setApiProfile`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let baseUrl = '';
let tokenProvider: () => string | undefined = () => undefined;
let onUnauthorized: () => void = () => undefined;
let profileId: string | null = null;

export function configureApi(opts: { baseUrl: string; getToken: () => string | undefined; onUnauthorized: () => void }) {
  baseUrl = opts.baseUrl;
  tokenProvider = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

export function apiBaseUrl(): string {
  return baseUrl;
}

/** The profile every request works on from now on (the API checks that it is one of the account's). */
export function setApiProfile(id: string | null) {
  profileId = id;
}

/** The ID token and the current profile, for every API request (and the chat stream). */
export function apiHeaders(): Record<string, string> {
  const token = tokenProvider();
  return { ...(token ? { Authorization: token } : {}), ...(profileId ? { [PROFILE_HEADER]: profileId } : {}) };
}

type Query = Record<string, string | number | boolean | string[] | undefined | null>;

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(path.replace(/^\//, ''), baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) url.searchParams.set(key, value.join(','));
    } else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Query; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers: {
      ...apiHeaders(),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'unauthorized', 'Your session expired. Please sign in again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, err.error ?? 'error', err.message ?? `Request failed (${res.status})`, err.details);
  }
  return data as T;
}
