import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { env } from '../lib/env';

let doc: DynamoDBDocumentClient | undefined;

export function ddb(): DynamoDBDocumentClient {
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
  });
  return doc;
}

export function table(): string {
  return env.tableName;
}

/** Strip single-table key attributes before returning items to callers. */
export function stripKeys<T extends Record<string, unknown>>(item: T): Omit<T, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK' | 'expiresAt'> {
  const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, expiresAt: _ttl, ...rest } = item;
  return rest;
}

export function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function ttlInDays(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}

/** Split an array into chunks (DynamoDB batch limits). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
