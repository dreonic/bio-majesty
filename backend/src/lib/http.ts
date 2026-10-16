import { ACCESS_GROUP, hasAccess } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { z } from 'zod';
import { env } from './env';
import { errorMessage, logger } from './logger';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const forbidden = (message: string) => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

let requestOrigin: string | undefined;

/** Remember the caller's Origin (Lambda handles one request at a time per instance). */
export function setRequestOrigin(event: Pick<APIGatewayProxyEvent, 'headers'>): void {
  const headers = event.headers ?? {};
  requestOrigin = headers.origin ?? headers.Origin ?? undefined;
}

export function corsHeaders(): Record<string, string> {
  const allowed = env.allowedOrigins;
  const origin = requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : (allowed[0] ?? '*');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    Vary: 'Origin',
  };
}

export function json(status: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

export function noContent(): APIGatewayProxyResult {
  return { statusCode: 204, headers: corsHeaders(), body: '' };
}

export function parseBody<S extends z.ZodType>(event: APIGatewayProxyEvent, schema: S): z.infer<S> {
  let raw: unknown = {};
  if (event.body) {
    const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest('Body must be valid JSON');
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw badRequest('Invalid request body', result.error.issues);
  return result.data;
}

/**
 * Parse query string parameters. Array-typed fields accept either repeated
 * keys (?c=a&c=b) or comma-separated values (?c=a,b).
 */
export function parseQuery<S extends z.ZodType>(
  event: APIGatewayProxyEvent,
  schema: S,
  arrayFields: string[] = [],
): z.infer<S> {
  const raw: Record<string, unknown> = { ...(event.queryStringParameters ?? {}) };
  for (const field of arrayFields) {
    const multi = event.multiValueQueryStringParameters?.[field];
    const values = (multi ?? (raw[field] !== undefined ? [String(raw[field])] : []))
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean);
    raw[field] = values.length ? values : undefined;
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw badRequest('Invalid query parameters', result.error.issues);
  return result.data;
}

export function pathParam(event: APIGatewayProxyEvent, name: string): string {
  const value = event.pathParameters?.[name];
  if (!value) throw badRequest(`Missing path parameter ${name}`);
  return decodeURIComponent(value);
}

export interface AuthUser {
  sub: string;
  email: string | null;
}

/** Claims injected by the Cognito user-pool authorizer. */
export function getUser(event: APIGatewayProxyEvent): AuthUser {
  const claims = (event.requestContext.authorizer?.claims ?? {}) as Record<string, string>;
  if (!claims.sub) throw new HttpError(401, 'unauthorized', 'Missing identity');
  return { sub: claims.sub, email: claims.email ?? null };
}

/** Every route needs the dashboard group: signing in alone is not enough (any Google account can). */
export function requireAccess(event: Pick<APIGatewayProxyEvent, 'requestContext'>): void {
  const claims = (event.requestContext?.authorizer?.claims ?? {}) as Record<string, unknown>;
  if (!hasAccess(claims['cognito:groups'])) {
    throw forbidden(`This account has no access to the dashboard yet. An admin can add it to the ${ACCESS_GROUP} group in Cognito.`);
  }
}

export function errorResponse(err: unknown): APIGatewayProxyResult {
  if (err instanceof HttpError) {
    return json(err.status, { error: err.code, message: err.message, details: err.details });
  }
  logger.error('Unhandled error', { error: errorMessage(err), stack: err instanceof Error ? err.stack : undefined });
  return json(500, { error: 'internal_error', message: 'Something went wrong. Check the logs for details.' });
}
