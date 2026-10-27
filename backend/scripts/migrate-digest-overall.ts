/**
 * One-off: give every stored digest the `overall` attribute. Digests now carry the run's overall
 * sentiment (null when the digest model failed); the ones written before have none and get null.
 * The run is idempotent and only adds an attribute the old version ignores, so it is safe before and
 * after deploying the version with overall sentiment: run it right before pushing that version and
 * again right after its deploy (which picks up digests written in between).
 *
 * Usage (needs AWS credentials; `--function` reads TABLE_NAME from a deployed Lambda, e.g. the
 * StockIngestFunction stack output):
 *   AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:digest-overall -w backend -- \
 *     --function <StockIngestFunction> [--dry-run]
 */
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ScanCommand, UpdateCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { planDigestOverall, type Item } from '../src/migrate/digest-overall';
import { ddb, table } from '../src/repo/client';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes('--dry-run');

/** Take the stack's resource names from a deployed function's environment. */
async function loadEnv(functionName: string): Promise<void> {
  const res = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  for (const [k, v] of Object.entries(res.Environment?.Variables ?? {})) process.env[k] ??= v;
}

async function scanDigests(): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const res: ScanCommandOutput = await ddb().send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: 'begins_with(SK, :digest)',
        ExpressionAttributeValues: { ':digest': 'DIGEST#' },
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
const keys = planDigestOverall(await scanDigests());
let updated = 0;
for (const Key of dryRun ? [] : keys) {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: table(),
        Key,
        UpdateExpression: 'SET overall = :none',
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(overall)',
        ExpressionAttributeValues: { ':none': null },
      }),
    );
    updated++;
  } catch (err) {
    // Written by the new version (or deleted) since the scan: nothing to do.
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
  }
}
console.log(dryRun ? `Would give ${keys.length} digests overall: null.` : `Gave ${updated} of ${keys.length} digests overall: null.`);
