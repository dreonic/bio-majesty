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

function image(raw: Record<string, unknown> | undefined): Article | null {
  if (!raw) return null;
  const item = unmarshall(raw as Record<string, AttributeValue>);
  return String(item.PK ?? '').startsWith('ART#') ? (item as unknown as Article) : null;
}

export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const oldImage = image(record.dynamodb?.OldImage);
    const newImage = image(record.dynamodb?.NewImage);
    const action = decideAction(oldImage, newImage);
    if (action === 'none') continue;
    try {
      if (action === 'index' && newImage) {
        const chunks = await indexArticle(newImage);
        await markIndexed(newImage.id, new Date().toISOString());
        logger.info('Indexed article', { id: newImage.id, chunks });
      } else if (action === 'delete') {
        const id = (newImage ?? oldImage)!.id;
        await deleteArticleVectors(id);
        if (newImage) await markIndexed(id, null);
        logger.info('Removed article from index', { id });
      }
    } catch (err) {
      logger.error('Indexing failed', { error: errorMessage(err), seq: record.dynamodb?.SequenceNumber });
      if (record.dynamodb?.SequenceNumber) failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures: failures };
}
