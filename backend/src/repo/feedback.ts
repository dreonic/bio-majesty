import { PutCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { Feedback, FeedbackStats } from '@bio-majesty/shared';
import { ddb, stripKeys, table } from './client';
import { accountPk, keys } from './keys';

/**
 * The account's review decisions, kept as training data (SK=FEEDBACK#<decidedAt>#<articleId>).
 * Re-reviews add a new record; consumers keep the latest per article.
 */
export async function putFeedback(sub: string, feedback: Feedback): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: table(),
      Item: { ...keys.feedback(sub, feedback.decidedAt, feedback.articleId), ...feedback },
    }),
  );
}

/** Newest first. `onlyCorrections` keeps records where the account's reviewer changed something. */
export async function listFeedback(sub: string, opts: { limit?: number; onlyCorrections?: boolean } = {}): Promise<Feedback[]> {
  const limit = opts.limit ?? 1000;
  const out: Feedback[] = [];
  const seen = new Set<string>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': accountPk(sub), ':p': 'FEEDBACK#' },
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

export async function feedbackStats(sub: string): Promise<FeedbackStats> {
  const all = await listFeedback(sub, { limit: 100_000 });
  return { total: all.length, corrections: all.filter((f) => f.changed.length > 0).length };
}
