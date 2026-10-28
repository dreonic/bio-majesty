/**
 * One-off: put every account's saved AI model choices on Claude Haiku 5.5, the new default (accounts
 * without saved choices already get it). Safe before or after the deploy: Haiku is in both versions'
 * catalog. Each account can pick other models again in Settings.
 *
 * Usage (needs AWS credentials; `--function` reads TABLE_NAME from a deployed Lambda, e.g. the
 * StockIngestFunction stack output):
 *   AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:models-haiku -w backend -- \
 *     --function <StockIngestFunction> [--dry-run]
 */
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ScanCommand, UpdateCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { planHaikuModels, type Item } from '../src/migrate/models-haiku';
import { ddb, table } from '../src/repo/client';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes('--dry-run');

/** Take the stack's resource names from a deployed function's environment. */
async function loadEnv(functionName: string): Promise<void> {
  const res = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  for (const [k, v] of Object.entries(res.Environment?.Variables ?? {})) process.env[k] ??= v;
}

async function scanSettings(): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const res: ScanCommandOutput = await ddb().send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: 'SK = :settings',
        ExpressionAttributeValues: { ':settings': 'SETTINGS' },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

const fn = opt('--function');
if (fn) await loadEnv(fn);
if (dryRun) console.log('Dry run: nothing is written.');
const items = await scanSettings();
const updates = planHaikuModels(items);
for (const u of updates) {
  const before = items.find((i) => i.PK === u.key.PK)?.data as { models?: Record<string, { model?: string }> } | undefined;
  const from = Object.entries(before?.models ?? {}).map(([task, s]) => `${task}=${s.model}`).join(', ');
  console.log(`${u.key.PK}: ${from}`);
}
let done = 0;
for (const u of dryRun ? [] : updates) {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: u.key,
      UpdateExpression: 'SET #data.models = :models',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#data': 'data' },
      ExpressionAttributeValues: { ':models': u.models },
    }),
  );
  done++;
}
console.log(`${dryRun ? 'Would switch' : 'Switched'} ${dryRun ? updates.length : done} of ${items.length} accounts' saved models to Haiku.`);
