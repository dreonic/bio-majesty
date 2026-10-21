import {
  DeleteVectorsCommand,
  ListVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  S3VectorsClient,
} from '@aws-sdk/client-s3vectors';
import type { Sentiment } from '@bio-majesty/shared';
import { env } from '../lib/env';
import { chunk } from '../repo/client';

let client: S3VectorsClient | undefined;
const s3v = () => (client ??= new S3VectorsClient({}));

/** Metadata stored with every chunk vector. Filterable: owner, articleId, publishedAt, categoryIds, sentiment. */
export interface ChunkMetadata {
  /** The account (Cognito sub) whose saved article this is: every query filters on it. */
  owner: string;
  articleId: string;
  chunk: number;
  publishedAt: number;
  categoryIds: string[];
  sentiment: Sentiment;
  /** Non-filterable (configured on the index). */
  title: string;
  text: string;
  source: string;
}

export const NON_FILTERABLE_KEYS = ['title', 'text', 'source'] as const;

export function vectorKey(sub: string, articleId: string, chunkIndex: number): string {
  return `${sub}#${articleId}#${chunkIndex}`;
}

export async function putChunkVectors(items: { key: string; vector: number[]; metadata: ChunkMetadata }[]): Promise<void> {
  for (const batch of chunk(items, 100)) {
    await s3v().send(
      new PutVectorsCommand({
        vectorBucketName: env.vectorBucket,
        indexName: env.vectorIndex,
        vectors: batch.map((i) => ({
          key: i.key,
          data: { float32: i.vector },
          metadata: i.metadata as unknown as Record<string, never>,
        })),
      }),
    );
  }
}

export async function deleteArticleVectors(sub: string, articleId: string, maxChunks = 64): Promise<void> {
  // Keys are deterministic, so delete the possible range without listing.
  const keys = Array.from({ length: maxChunks }, (_, i) => vectorKey(sub, articleId, i));
  for (const batch of chunk(keys, 100)) {
    await s3v().send(
      new DeleteVectorsCommand({ vectorBucketName: env.vectorBucket, indexName: env.vectorIndex, keys: batch }),
    );
  }
}

export interface VectorFilter {
  /** Required: an account only ever searches its own saved news. */
  owner: string;
  from?: Date;
  to?: Date;
  categoryIds?: string[];
  sentiments?: Sentiment[];
}

/** Build an S3 Vectors metadata filter ($eq on a list field matches any element). */
export function buildFilter(f: VectorFilter): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [{ owner: { $eq: f.owner } }];
  if (f.from || f.to) {
    const range: Record<string, number> = {};
    if (f.from) range.$gte = Math.floor(f.from.getTime() / 1000);
    if (f.to) range.$lte = Math.floor(f.to.getTime() / 1000);
    clauses.push({ publishedAt: range });
  }
  if (f.categoryIds?.length) {
    clauses.push({ $or: f.categoryIds.map((id) => ({ categoryIds: { $eq: id } })) });
  }
  if (f.sentiments?.length) clauses.push({ sentiment: { $in: f.sentiments } });
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

export interface VectorHit {
  key: string;
  distance: number;
  metadata: ChunkMetadata;
}

export async function queryVectors(vector: number[], topK: number, filter: VectorFilter): Promise<VectorHit[]> {
  const res = await s3v().send(
    new QueryVectorsCommand({
      vectorBucketName: env.vectorBucket,
      indexName: env.vectorIndex,
      queryVector: { float32: vector },
      topK,
      filter: buildFilter(filter) as never,
      returnMetadata: true,
      returnDistance: true,
    }),
  );
  return (res.vectors ?? []).map((v) => ({
    key: v.key ?? '',
    distance: v.distance ?? 1,
    metadata: v.metadata as unknown as ChunkMetadata,
  }));
}

/** Count vectors (used by the re-index script for a sanity check). */
export async function countVectors(): Promise<number> {
  let count = 0;
  let token: string | undefined;
  do {
    const res = await s3v().send(
      new ListVectorsCommand({ vectorBucketName: env.vectorBucket, indexName: env.vectorIndex, nextToken: token }),
    );
    count += res.vectors?.length ?? 0;
    token = res.nextToken;
  } while (token);
  return count;
}
