import { GetCommand, PutCommand, QueryCommand, UpdateCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { EMPTY_STATS, type Run, type RunStats, type UsageEntry } from '@bio-majesty/shared';
import { randomId } from '../lib/ids';
import { ddb, queryPrefix, stripKeys, table, ttlInDays } from './client';
import { keys, profilePk, type ProfileId } from './keys';

export async function createRun(profileId: ProfileId, run: Omit<Run, 'stats' | 'usage' | 'finishedAt' | 'error' | 'status'>): Promise<Run> {
  const full: Run = { ...run, status: 'running', stats: { ...EMPTY_STATS }, usage: [], finishedAt: null, error: null };
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.run(profileId, run.id), ...full } }));
  return full;
}

export async function getRun(profileId: ProfileId, id: string): Promise<Run | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.run(profileId, id) }));
  return res.Item ? (stripKeys(res.Item) as unknown as Run) : null;
}

/** The profile's runs, newest first (run ids sort by start time). */
export async function listRuns(profileId: ProfileId, limit = 20): Promise<Run[]> {
  const items = await queryPrefix(profilePk(profileId), 'RUN#', { descending: true, limit });
  return items.map((i) => stripKeys(i) as unknown as Run);
}

export async function lastSuccessfulDailyRun(profileId: ProfileId): Promise<Run | null> {
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': profilePk(profileId), ':p': 'RUN#' },
        ScanIndexForward: false,
        Limit: 50,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) {
      const run = stripKeys(item) as unknown as Run;
      if (run.type === 'daily' && run.status === 'succeeded') return run;
    }
    startKey = res.LastEvaluatedKey;
    if (!startKey) break;
  }
  return null;
}

/** Atomically add counters to the run stats. */
export async function addRunStats(profileId: ProfileId, id: string, delta: Partial<RunStats>): Promise<void> {
  const entries = Object.entries(delta).filter(([, v]) => typeof v === 'number' && v !== 0);
  if (!entries.length) return;
  const names: Record<string, string> = { '#stats': 'stats' };
  const values: Record<string, number> = {};
  const parts = entries.map(([k, v], i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = v as number;
    return `#stats.#k${i} :v${i}`;
  });
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.run(profileId, id),
      UpdateExpression: `ADD ${parts.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Record token usage from one pipeline step. Stored as separate items so that
 * concurrent enrich invocations never overwrite each other; `aggregateRunUsage`
 * folds them into the run record when the run finishes.
 */
export async function recordRunUsage(runId: string, usage: UsageEntry[]): Promise<void> {
  if (!usage.length) return;
  await ddb().send(
    new PutCommand({
      TableName: table(),
      Item: { PK: `RUNUSAGE#${runId}`, SK: randomId(12), usage, expiresAt: ttlInDays(60) },
    }),
  );
}

export function mergeUsage(entries: UsageEntry[]): UsageEntry[] {
  const merged = new Map<string, UsageEntry>();
  for (const u of entries) {
    const key = `${u.task}|${u.model}`;
    const cur = merged.get(key);
    if (cur) {
      cur.calls += u.calls;
      cur.inputTokens += u.inputTokens;
      cur.outputTokens += u.outputTokens;
    } else merged.set(key, { ...u });
  }
  return [...merged.values()];
}

export async function aggregateRunUsage(profileId: ProfileId, runId: string): Promise<UsageEntry[]> {
  const all: UsageEntry[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `RUNUSAGE#${runId}` },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) all.push(...((item.usage as UsageEntry[] | undefined) ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  const usage = mergeUsage(all);
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.run(profileId, runId),
      UpdateExpression: 'SET #usage = :u',
      ExpressionAttributeNames: { '#usage': 'usage' },
      ExpressionAttributeValues: { ':u': usage },
    }),
  );
  return usage;
}

/** Mark a run that is still running as cancelled (failed); a run that has finished meanwhile stays as it is. */
export async function cancelRun(profileId: ProfileId, id: string): Promise<void> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: table(),
        Key: keys.run(profileId, id),
        UpdateExpression: 'SET #status = :failed, finishedAt = :f, #error = :e',
        ConditionExpression: '#status = :running',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: { ':failed': 'failed', ':running': 'running', ':f': new Date().toISOString(), ':e': 'Cancelled' },
      }),
    );
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
  }
}

export async function finishRun(profileId: ProfileId, id: string, status: 'succeeded' | 'failed', error: string | null = null): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.run(profileId, id),
      UpdateExpression: 'SET #status = :s, finishedAt = :f, #error = :e',
      ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
      ExpressionAttributeValues: { ':s': status, ':f': new Date().toISOString(), ':e': error },
    }),
  );
}
