import { PutCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { Feedback, FeedbackStats } from '@bio-majesty/shared';
import { ddb, stripKeys, table } from './client';

/**
 * Review decisions kept as training data (PK=FEEDBACK, SK=<decidedAt>#<articleId>).
 * Re-reviews add a new record; consumers keep the latest per article.
 */
export async function putFeedback(feedback: Feedback): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: table(),
      Item: { PK: 'FEEDBACK', SK: `${feedback.decidedAt}#${feedback.articleId}`, ...feedback },
    }),
  );
}

/** Newest first. `onlyCorrections` keeps records where the exec changed something. */
export async function listFeedback(opts: { limit?: number; onlyCorrections?: boolean } = {}): Promise<Feedback[]> {
  const limit = opts.limit ?? 1000;
  const out: Feedback[] = [];
  const seen = new Set<string>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': 'FEEDBACK' },
        ScanIndexForward: false,
        ExclusiveStartKey: startKey,
        Limit: 200,
      }),
    );
    for (const item of res.Items ?? []) {
      const f = stripKeys(item) as unknown as Feedback;
      if (seen.has(f.articleId)) continue; // keep the latest decision per article
      seen.add(f.articleId);
      if (opts.onlyCorrections && !f.changed.length) continue;
      out.push(f);
      if (out.length >= limit) return out;
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}

export async function feedbackStats(): Promise<FeedbackStats> {
  const all = await listFeedback({ limit: 100_000 });
  return { total: all.length, corrections: all.filter((f) => f.changed.length > 0).length };
}
