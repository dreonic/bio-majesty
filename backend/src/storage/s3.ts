import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../lib/env';

let client: S3Client | undefined;
const s3 = () => (client ??= new S3Client({}));

export async function putJson(key: string, value: unknown): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.dataBucket,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    }),
  );
}

export async function getJson<T>(key: string): Promise<T | null> {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: env.dataBucket, Key: key }));
    const text = await res.Body?.transformToString('utf-8');
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    if (err instanceof NoSuchKey || (err as { name?: string }).name === 'NoSuchKey') return null;
    throw err;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: env.dataBucket, Key: key }));
}

/** Delete many objects (missing keys are fine). */
export async function deleteObjects(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const res = await s3().send(
      new DeleteObjectsCommand({
        Bucket: env.dataBucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
    if (res.Errors?.length) throw new Error(`Could not delete ${res.Errors.length} object(s): ${res.Errors[0]?.Message ?? 'unknown error'}`);
  }
}

export async function listKeys(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3().send(
      new ListObjectsV2Command({ Bucket: env.dataBucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) if (obj.Key) out.push(obj.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Object key layout in the data bucket. */
export const s3Keys = {
  /** Extracted text of an account's article (each account fetches its own copy). */
  articleText: (sub: string, id: string) => `users/${sub}/articles/${id}.json`,
  rawResults: (runId: string, taskId: string) => `raw/${runId}/${taskId}.json`,
  rawPrefix: (runId: string) => `raw/${runId}/`,
  candidates: (runId: string) => `runs/${runId}/candidates.json`,
  relevant: (runId: string) => `runs/${runId}/relevant.json`,
  relevantItem: (runId: string, candidateId: string) => `runs/${runId}/items/${candidateId}.json`,
  chat: (sub: string, id: string) => `chats/${sub}/${id}.json`,
  /** Every prefix holding one account's objects (deleted with the account). */
  accountPrefixes: (sub: string) => [`users/${sub}/`, `chats/${sub}/`],
};
