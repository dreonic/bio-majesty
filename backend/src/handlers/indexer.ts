import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { effectiveSummary, effectiveTags, type Article } from '@bio-majesty/shared';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { errorMessage, logger } from '../lib/logger';
import { markIndexed } from '../repo/articles';
import { indexArticle } from '../vectors/indexer';
import { deleteArticleVectors } from '../vectors/store';

type Action = 'index' | 'delete' | 'none';

/** Decide what a stream record means for the vector index. */
export function decideAction(oldImage: Article | null, newImage: Article | null): Action {
  const wasApproved = oldImage?.status === 'APPROVED';
  const isApproved = newImage?.status === 'APPROVED';
  if (isApproved && !wasApproved) return 'index';
  if (wasApproved && !isApproved) return 'delete';
  if (isApproved && wasApproved && oldImage && newImage) {
    const a = effectiveTags(oldImage);
    const b = effectiveTags(newImage);
    const changed =
      a.sentiment !== b.sentiment ||
      [...a.categoryIds].sort().join(',') !== [...b.categoryIds].sort().join(',') ||
      oldImage.title !== newImage.title ||
      effectiveSummary(oldImage) !== effectiveSummary(newImage);
    return changed ? 'index' : 'none'; // indexedAt-only updates land here and are ignored
  }
  return 'none';
}

/** An account's article item (PK USER#<sub>, SK ART#<id>), with the account it belongs to. */
export function image(raw: Record<string, unknown> | undefined): { sub: string; article: Article } | null {
  if (!raw) return null;
  const item = unmarshall(raw as Record<string, AttributeValue>);
  const pk = String(item.PK ?? '');
  if (!pk.startsWith('USER#') || !String(item.SK ?? '').startsWith('ART#')) return null;
  // A soft-deleted (filtered) article is never saved, so it is never in the index.
  return { sub: pk.slice('USER#'.length), article: item as unknown as Article };
}

export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const before = image(record.dynamodb?.OldImage);
    const after = image(record.dynamodb?.NewImage);
    const action = decideAction(before?.article ?? null, after?.article ?? null);
    if (action === 'none') continue;
    const sub = (after ?? before)!.sub;
    try {
      if (action === 'index' && after) {
        const chunks = await indexArticle(sub, after.article);
        await markIndexed(sub, after.article.id, new Date().toISOString());
        logger.info('Indexed article', { id: after.article.id, chunks });
      } else if (action === 'delete') {
        const id = (after ?? before)!.article.id;
        await deleteArticleVectors(sub, id);
        if (after) await markIndexed(sub, id, null);
        logger.info('Removed article from index', { id });
      }
    } catch (err) {
      logger.error('Indexing failed', { error: errorMessage(err), seq: record.dynamodb?.SequenceNumber });
      if (record.dynamodb?.SequenceNumber) failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures: failures };
}
