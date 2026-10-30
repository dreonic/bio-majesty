import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { effectiveTags, type Article, type ArticleStatus, type FinalTags, type Sentiment } from '@bio-majesty/shared';
import { nowIso } from '../lib/time';
import { aliasKeys, extractGoogleNewsId, type AliasKey } from '../lib/url';
import { chunk, ddb, decodeCursor, encodeCursor, stripKeys, table, ttlInDays } from './client';
import { keys, type ProfileId } from './keys';

const FILTERED_TTL_DAYS = 30;

/** Stored with each article item, but not part of the API's Article. */
interface ArticleExtras {
  /** Dedupe keys of this article: deleted with it when it is deleted from the recycle bin. */
  aliasIds?: Set<string> | string[];
  /** Set when a filtered article is deleted (soft delete): hidden everywhere, its dedupe keys stay. */
  deletedAt?: string;
}

type ArticleItem = Article & ArticleExtras & Record<string, unknown>;

function toItem(profileId: ProfileId, article: Article, aliasIds: string[]): Record<string, unknown> {
  return {
    ...keys.article(profileId, article.id),
    ...keys.articleGsi(profileId, article.status, article.publishedAt, article.id),
    ...article,
    // A DynamoDB string set (ADD-able when another run finds the article under a new key).
    ...(aliasIds.length ? { aliasIds: new Set(aliasIds) } : {}),
    ...(article.status === 'FILTERED' ? { expiresAt: ttlInDays(FILTERED_TTL_DAYS) } : {}),
  };
}

function fromItem(item: Record<string, unknown>): Article {
  const { aliasIds: _aliases, deletedAt: _deleted, ...article } = stripKeys(item as ArticleItem);
  return article as Article;
}

const isHidden = (item: Record<string, unknown>) => typeof item.deletedAt === 'string';

const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export function aliasId(alias: AliasKey): string {
  return `${alias.kind}#${alias.hash}`;
}

/**
 * Create the article together with its dedupe keys. Returns false when it already existed; the
 * keys are then added to the existing article (a later run may know it under another URL).
 */
export async function createArticle(profileId: ProfileId, article: Article, aliases: AliasKey[]): Promise<boolean> {
  const ids = [...new Set(aliases.map(aliasId))];
  let created = true;
  try {
    await ddb().send(
      new PutCommand({
        TableName: table(),
        Item: toItem(profileId, article, ids),
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
    created = false;
    if (ids.length) await addAliasIds(profileId, article.id, ids);
  }
  await putAliasItems(profileId, article.id, ids);
  return created;
}

async function addAliasIds(profileId: ProfileId, articleId: string, ids: string[]): Promise<void> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: table(),
        Key: keys.article(profileId, articleId),
        UpdateExpression: 'ADD aliasIds :ids',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':ids': new Set(ids) },
      }),
    );
  } catch (err) {
    if (!isConditionFailure(err)) throw err; // deleted meanwhile
  }
}

async function putAliasItems(profileId: ProfileId, articleId: string, ids: string[]): Promise<void> {
  for (const batch of chunk(ids, 25)) {
    let request: Record<string, { PutRequest: { Item: Record<string, unknown> } }[]> | undefined = {
      [table()]: batch.map((id) => ({ PutRequest: { Item: { ...keys.alias(profileId, id), articleId } } })),
    };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchWriteCommand({ RequestItems: request }));
      request = res.UnprocessedItems as typeof request;
    }
  }
}

/** The profile's article, or null if it doesn't exist or was deleted from the filtered list. */
export async function getArticle(profileId: ProfileId, id: string): Promise<Article | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.article(profileId, id) }));
  return res.Item && !isHidden(res.Item) ? fromItem(res.Item) : null;
}

export async function batchGetArticles(profileId: ProfileId, ids: string[]): Promise<Article[]> {
  const unique = [...new Set(ids)];
  const out: Article[] = [];
  for (const batch of chunk(unique, 100)) {
    let request: Record<string, { Keys: Record<string, unknown>[] }> | undefined = {
      [table()]: { Keys: batch.map((id) => keys.article(profileId, id)) },
    };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchGetCommand({ RequestItems: request }));
      for (const item of res.Responses?.[table()] ?? []) if (!isHidden(item)) out.push(fromItem(item));
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
export async function applyReview(profileId: ProfileId, article: Article, change: ReviewChange): Promise<Article> {
  const status = change.status ?? article.status;
  const final = change.final === undefined ? article.final : change.final;
  const reviewedAt = nowIso();
  const gsi = keys.articleGsi(profileId, status, article.publishedAt, article.id);

  const res = await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.article(profileId, article.id),
      UpdateExpression:
        status === 'FILTERED'
          ? 'SET #status = :status, #final = :final, reviewedAt = :reviewedAt, GSI1PK = :g1, GSI1SK = :g2'
          : 'SET #status = :status, #final = :final, reviewedAt = :reviewedAt, GSI1PK = :g1, GSI1SK = :g2 REMOVE expiresAt',
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
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

export async function markIndexed(profileId: ProfileId, id: string, indexedAt: string | null): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.article(profileId, id),
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
 * The profile's articles, newest first, by status and publish-date window. Keyword, category and
 * sentiment filters are applied in Lambda (volumes are small).
 */
export async function listArticles(profileId: ProfileId, opts: ListArticlesOptions): Promise<{ items: Article[]; nextCursor: string | null }> {
  const from = (opts.from ?? new Date('2000-01-01T00:00:00Z')).toISOString();
  const to = `${(opts.to ?? new Date(Date.now() + 24 * 3600 * 1000)).toISOString()}~`;
  const maxScan = opts.maxScan ?? 3000;
  const needle = opts.q?.trim().toLowerCase();
  const terms = needle ? needle.split(/\s+/).filter(Boolean) : [];
  const { GSI1PK } = keys.articleGsi(profileId, opts.status, '', '');

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
        ExpressionAttributeValues: { ':pk': GSI1PK, ':from': from, ':to': to },
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

/** Pages of ids of every article of the profile with this status, newest first. */
export async function* articleIdPages(profileId: ProfileId, status: ArticleStatus): AsyncGenerator<string[]> {
  const { GSI1PK } = keys.articleGsi(profileId, status, '', '');
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': GSI1PK },
        ProjectionExpression: 'SK',
        ScanIndexForward: false,
        ExclusiveStartKey: startKey,
      }),
    );
    const ids = (res.Items ?? []).map((item) => String(item.SK).replace(/^ART#/, ''));
    if (ids.length) yield ids;
    startKey = res.LastEvaluatedKey;
  } while (startKey);
}

export interface RemoveResult {
  /** Recycle-bin articles deleted for good, with their dedupe keys. */
  deleted: string[];
  /** Filtered articles hidden (soft delete): their dedupe keys stay. */
  hidden: string[];
  /** Left alone: already gone, or neither skipped nor filtered. */
  notDeletable: string[];
}

/**
 * Delete skipped and filtered articles. A skipped article (the recycle bin) is deleted for good
 * together with its dedupe keys, so a later run or backfill can find it again. A filtered article
 * is soft-deleted: it leaves the list and counts, but its keys stay, so later runs keep dropping it.
 * DynamoDB checks the status, so pending and saved news is never touched, even in a race.
 */
export async function removeArticles(profileId: ProfileId, ids: string[]): Promise<RemoveResult> {
  const out: RemoveResult = { deleted: [], hidden: [], notDeletable: [] };
  for (const batch of chunk([...new Set(ids)], 25)) {
    await Promise.all(
      batch.map(async (id) => {
        const removed = await deleteSkipped(profileId, id);
        if (removed) {
          await deleteAliasItems(profileId, id, aliasIdsOf(removed));
          out.deleted.push(id);
        } else if (await hideFiltered(profileId, id)) {
          out.hidden.push(id);
        } else {
          out.notDeletable.push(id);
        }
      }),
    );
  }
  return out;
}

/** Delete a recycle-bin article; returns the deleted item, or null if it isn't in the bin. */
async function deleteSkipped(profileId: ProfileId, id: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await ddb().send(
      new DeleteCommand({
        TableName: table(),
        Key: keys.article(profileId, id),
        ConditionExpression: '#status = :rejected',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':rejected': 'REJECTED' satisfies ArticleStatus },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return res.Attributes ?? {};
  } catch (err) {
    if (isConditionFailure(err)) return null;
    throw err;
  }
}

async function hideFiltered(profileId: ProfileId, id: string): Promise<boolean> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: table(),
        Key: keys.article(profileId, id),
        UpdateExpression: 'SET deletedAt = :now REMOVE GSI1PK, GSI1SK',
        ConditionExpression: '#status = :filtered AND attribute_not_exists(deletedAt)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':now': nowIso(), ':filtered': 'FILTERED' satisfies ArticleStatus },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/** Dedupe keys of a stored article (computed for articles saved before they were recorded with it). */
export function aliasIdsOf(item: Record<string, unknown>): string[] {
  const stored = item.aliasIds;
  if (stored instanceof Set) return [...stored].map(String);
  if (Array.isArray(stored)) return stored.map(String);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return aliasKeys({
    url: str(item.url),
    gnewsId: str(item.sourceUrl) ? extractGoogleNewsId(str(item.sourceUrl)!) : null,
    title: str(item.title) ?? '',
    sourceName: str(item.sourceName),
    sourceDomain: str(item.sourceDomain),
  }).map(aliasId);
}

/** Delete dedupe keys that still point at this article (another article may have taken one over). */
async function deleteAliasItems(profileId: ProfileId, articleId: string, ids: string[]): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      try {
        await ddb().send(
          new DeleteCommand({
            TableName: table(),
            Key: keys.alias(profileId, id),
            ConditionExpression: 'articleId = :id',
            ExpressionAttributeValues: { ':id': articleId },
          }),
        );
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
      }
    }),
  );
}

export async function countByStatus(profileId: ProfileId, status: ArticleStatus): Promise<number> {
  const { GSI1PK } = keys.articleGsi(profileId, status, '', '');
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': GSI1PK },
        Select: 'COUNT',
        ExclusiveStartKey: startKey,
      }),
    );
    count += res.Count ?? 0;
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return count;
}

/** Returns the subset of the profile's dedupe keys that already exist (as alias ids). */
export async function existingAliases(profileId: ProfileId, aliases: AliasKey[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(aliases.map(aliasId))];
  for (const batch of chunk(unique, 100)) {
    let request: Record<string, { Keys: Record<string, unknown>[]; ProjectionExpression: string }> | undefined = {
      [table()]: { Keys: batch.map((id) => keys.alias(profileId, id)), ProjectionExpression: 'SK' },
    };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchGetCommand({ RequestItems: request }));
      for (const item of res.Responses?.[table()] ?? []) {
        found.add(String(item.SK).replace(/^ALIAS#/, ''));
      }
      request = res.UnprocessedKeys as typeof request;
    }
  }
  return found;
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
