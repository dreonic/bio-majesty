/**
 * One-off: categories store their backfill as a period ({amount, unit}) instead of whole months. This
 * adds `backfill.period` to categories that only have `backfill.months` and keeps `months`, so both
 * versions work while the deploy runs: run it right before pushing the version with periods and again
 * right after its deploy. Once all is well, `--cleanup --yes` removes `months`.
 *
 * Usage (needs AWS credentials; `--function` reads TABLE_NAME from a deployed Lambda, e.g. the
 * StockIngestFunction stack output):
 *   AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:backfill-period -w backend -- \
 *     --function <StockIngestFunction> [--dry-run] [--cleanup --yes]
 */
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ScanCommand, UpdateCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { planBackfillPeriods, planMonthsCleanup, type Item } from '../src/migrate/backfill-period';
import { ddb, table } from '../src/repo/client';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');
if (cleanup && !dryRun && !args.includes('--yes')) throw new Error('--cleanup deletes the old months: add --yes (or --dry-run first)');

/** Take the stack's resource names from a deployed function's environment. */
async function loadEnv(functionName: string): Promise<void> {
  const res = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  for (const [k, v] of Object.entries(res.Environment?.Variables ?? {})) process.env[k] ??= v;
}

async function scanCategories(): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const res: ScanCommandOutput = await ddb().send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: 'begins_with(SK, :category)',
        ExpressionAttributeValues: { ':category': 'CATEGORY#' },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** Run a conditional update; a category changed or deleted since the scan is skipped. */
async function update(input: ConstructorParameters<typeof UpdateCommand>[0]): Promise<boolean> {
  try {
    await ddb().send(new UpdateCommand(input));
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

const fn = opt('--function');
if (fn) await loadEnv(fn);
if (dryRun) console.log('Dry run: nothing is written.');
const items = await scanCategories();

if (cleanup) {
  const keys = planMonthsCleanup(items);
  let done = 0;
  for (const Key of dryRun ? [] : keys) {
    if (await update({ TableName: table(), Key, UpdateExpression: 'REMOVE backfill.months', ConditionExpression: 'attribute_exists(backfill.period)' })) done++;
  }
  console.log(dryRun ? `Would remove months from ${keys.length} categories.` : `Removed months from ${done} of ${keys.length} categories.`);
} else {
  const updates = planBackfillPeriods(items);
  for (const u of updates) console.log(`${u.key.PK} ${u.key.SK}: ${u.period ? `${u.period.amount} ${u.period.unit}` : 'no backfill'}`);
  let done = 0;
  for (const u of dryRun ? [] : updates) {
    const written = await update({
      TableName: table(),
      Key: u.key,
      UpdateExpression: 'SET backfill.period = :period',
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(backfill.period)',
      ExpressionAttributeValues: { ':period': u.period },
    });
    if (written) done++;
  }
  console.log(dryRun ? `Would give ${updates.length} categories a period.` : `Gave ${done} of ${updates.length} categories a period.`);
}
