import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import {
  effectiveTags,
  type Article,
  type ArticleStatus,
  type FinalTags,
  type Sentiment,
} from '@bio-majesty/shared';
import { nowIso } from '../lib/time';
import type { AliasKey } from '../lib/url';
import { chunk, ddb, decodeCursor, encodeCursor, stripKeys, table, ttlInDays } from './client';
import { keys } from './keys';

const FILTERED_TTL_DAYS = 30;

type ArticleItem = Article & Record<string, unknown>;

function toItem(article: Article): Record<string, unknown> {
  return {
    ...keys.article(article.id),
    ...keys.articleGsi(article.status, article.publishedAt, article.id),
    ...article,
    ...(article.status === 'FILTERED' ? { expiresAt: ttlInDays(FILTERED_TTL_DAYS) } : {}),
  };
}

function fromItem(item: Record<string, unknown>): Article {
  return stripKeys(item as ArticleItem) as Article;
}

/** Create the article if it does not exist yet. Returns false when it already existed. */
export async function createArticle(article: Article): Promise<boolean> {
  try {
    await ddb().send(
      new PutCommand({
        TableName: table(),
        Item: toItem(article),
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function getArticle(id: string): Promise<Article | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.article(id) }));
  return res.Item ? fromItem(res.Item) : null;
}

export async function batchGetArticles(ids: string[]): Promise<Article[]> {
  const unique = [...new Set(ids)];
  const out: Article[] = [];
  for (const batch of chunk(unique, 100)) {
    let request: Record<string, { Keys: Record<string, unknown>[] }> | undefined = {
      [table()]: { Keys: batch.map((id) => keys.article(id)) },
    };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchGetCommand({ RequestItems: request }));
      for (const item of res.Responses?.[table()] ?? []) out.push(fromItem(item));
      request = res.UnprocessedKeys as typeof request;
    }
  }
  const order = new Map(unique.map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export interface ReviewChange {
  status?: ArticleStatus;
  final?: FinalTags | null;
}

/** Apply a review decision; keeps GSI1 and TTL attributes consistent with the status. */
export async function applyReview(article: Article, change: ReviewChange): Promise<Article> {
  const status = change.status ?? article.status;
  const final = change.final === undefined ? article.final : change.final;
  const reviewedAt = nowIso();
  const gsi = keys.articleGsi(status, article.publishedAt, article.id);

  const res = await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.article(article.id),
      UpdateExpression:
        status === 'FILTERED'
          ? 'SET #status = :status, #final = :final, reviewedAt = :reviewedAt, GSI1PK = :g1, GSI1SK = :g2'
          : 'SET #status = :status, #final = :final, reviewedAt = :reviewedAt, GSI1PK = :g1, GSI1SK = :g2 REMOVE expiresAt',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#status': 'status', '#final': 'final' },
      ExpressionAttributeValues: {
        ':status': status,
        ':final': final,
        ':reviewedAt': reviewedAt,
        ':g1': gsi.GSI1PK,
        ':g2': gsi.GSI1SK,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return fromItem(res.Attributes ?? {});
}

export async function markIndexed(id: string, indexedAt: string | null): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.article(id),
      UpdateExpression: 'SET indexedAt = :t',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':t': indexedAt },
    }),
  );
}

export interface ListArticlesOptions {
  status: ArticleStatus;
  from?: Date;
  to?: Date;
  categories?: string[];
  sentiments?: Sentiment[];
  q?: string;
  limit: number;
  cursor?: string;
  /** Safety cap on items read per request when filters are selective. */
  maxScan?: number;
}

/**
 * Newest-first listing by status and publish-date window. Keyword, category
 * and sentiment filters are applied in Lambda (volumes are small).
 */
export async function listArticles(opts: ListArticlesOptions): Promise<{ items: Article[]; nextCursor: string | null }> {
  const from = (opts.from ?? new Date('2000-01-01T00:00:00Z')).toISOString();
  const to = `${(opts.to ?? new Date(Date.now() + 24 * 3600 * 1000)).toISOString()}~`;
  const maxScan = opts.maxScan ?? 3000;
  const needle = opts.q?.trim().toLowerCase();
  const terms = needle ? needle.split(/\s+/).filter(Boolean) : [];

  const items: Article[] = [];
  let startKey = decodeCursor(opts.cursor);
  let scanned = 0;
  let lastReturnedKey: Record<string, unknown> | undefined;
  let exhausted = false;

  while (items.length < opts.limit && scanned < maxScan) {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': `STATUS#${opts.status}`, ':from': from, ':to': to },
        ScanIndexForward: false,
        Limit: 200,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of res.Items ?? []) {
      scanned++;
      const article = fromItem(raw);
      if (!matches(article, opts.categories, opts.sentiments, terms)) continue;
      items.push(article);
      lastReturnedKey = { PK: raw.PK, SK: raw.SK, GSI1PK: raw.GSI1PK, GSI1SK: raw.GSI1SK };
      if (items.length >= opts.limit) break;
    }
    if (items.length >= opts.limit) break;
    if (!res.LastEvaluatedKey) {
      exhausted = true;
      break;
    }
    startKey = res.LastEvaluatedKey;
    lastReturnedKey = res.LastEvaluatedKey;
  }

  return { items, nextCursor: exhausted ? null : encodeCursor(lastReturnedKey) };
}

function matches(a: Article, categories?: string[], sentiments?: Sentiment[], terms: string[] = []): boolean {
  const tags = effectiveTags(a);
  if (categories?.length && !tags.categoryIds.some((c) => categories.includes(c))) return false;
  if (sentiments?.length && !sentiments.includes(tags.sentiment)) return false;
  if (terms.length) {
    const hay = `${a.title} ${a.suggestion?.summary ?? ''} ${a.snippet ?? ''} ${a.sourceName ?? ''}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
}

export async function countByStatus(status: ArticleStatus): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `STATUS#${status}` },
        Select: 'COUNT',
        ExclusiveStartKey: startKey,
      }),
    );
    count += res.Count ?? 0;
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return count;
}

/** Returns the subset of alias keys that already exist. */
export async function existingAliases(aliases: AliasKey[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Map(aliases.map((a) => [`${a.kind}#${a.hash}`, a])).values()];
  for (const batch of chunk(unique, 100)) {
    let request: Record<string, { Keys: Record<string, unknown>[]; ProjectionExpression: string }> | undefined = {
      [table()]: { Keys: batch.map((a) => keys.alias(a)), ProjectionExpression: 'PK' },
    };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchGetCommand({ RequestItems: request }));
      for (const item of res.Responses?.[table()] ?? []) {
        found.add(String(item.PK).replace(/^ALIAS#/, ''));
      }
      request = res.UnprocessedKeys as typeof request;
    }
  }
  return found;
}

export function aliasId(alias: AliasKey): string {
  return `${alias.kind}#${alias.hash}`;
}

export async function putAliases(articleId: string, aliases: AliasKey[]): Promise<void> {
  const unique = [...new Map(aliases.map((a) => [aliasId(a), a])).values()];
  for (const batch of chunk(unique, 25)) {
    let request: Record<string, { PutRequest: { Item: Record<string, unknown> } }[]> | undefined = {
      [table()]: batch.map((a) => ({ PutRequest: { Item: { ...keys.alias(a), articleId } } })),
    };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchWriteCommand({ RequestItems: request }));
      request = res.UnprocessedItems as typeof request;
    }
  }
}

/** Record that a run produced an article (lets the digest find "new in this run"). */
export async function addRunItem(runId: string, articleId: string): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: table(),
      Item: { ...keys.runItem(runId, articleId), expiresAt: ttlInDays(60) },
    }),
  );
}

export async function listRunItems(runId: string): Promise<string[]> {
  const ids: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `RUNITEM#${runId}` },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) ids.push(String(item.SK));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return ids;
}
