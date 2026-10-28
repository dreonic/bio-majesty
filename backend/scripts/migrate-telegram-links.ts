/**
 * One-off: accounts now have several Telegram connections (`TELEGRAM#<id>` items) instead of one
 * `TELEGRAM` item. This writes each linked account's connection as a new item and keeps the old one,
 * so both versions work while the deploy runs: run it right before pushing the version with several
 * connections and again right after its deploy. Once all is well, `--cleanup --yes` removes the old items.
 *
 * Usage (needs AWS credentials; `--function` reads TABLE_NAME from a deployed Lambda, e.g. the
 * StockIngestFunction stack output):
 *   AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:telegram-links -w backend -- \
 *     --function <StockIngestFunction> [--dry-run] [--cleanup --yes]
 */
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteCommand, PutCommand, ScanCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { planOldLinkCleanup, planTelegramLinks, type Item } from '../src/migrate/telegram-links';
import { ddb, table } from '../src/repo/client';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');
if (cleanup && !dryRun && !args.includes('--yes')) throw new Error('--cleanup deletes the old items: add --yes (or --dry-run first)');

/** Take the stack's resource names from a deployed function's environment. */
async function loadEnv(functionName: string): Promise<void> {
  const res = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  for (const [k, v] of Object.entries(res.Environment?.Variables ?? {})) process.env[k] ??= v;
}

async function scanTelegram(): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const res: ScanCommandOutput = await ddb().send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: 'begins_with(SK, :telegram)',
        ExpressionAttributeValues: { ':telegram': 'TELEGRAM' },
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
const items = await scanTelegram();

if (cleanup) {
  const keys = planOldLinkCleanup(items);
  for (const Key of dryRun ? [] : keys) await ddb().send(new DeleteCommand({ TableName: table(), Key }));
  console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${keys.length} old single-link items.`);
} else {
  const existing = new Set(items.map((i) => `${String(i.PK)} ${String(i.SK)}`));
  const todo = planTelegramLinks(items).filter(({ pk, link }) => !existing.has(`${pk} TELEGRAM#${link.id}`));
  for (const { pk, link } of todo) console.log(`${pk}: ${link.kind} "${link.chatTitle}" (${link.id})`);
  for (const { pk, link } of dryRun ? [] : todo) {
    await ddb().send(
      new PutCommand({
        TableName: table(),
        Item: { PK: pk, SK: `TELEGRAM#${link.id}`, ...link },
        // A connection made with the new version meanwhile wins.
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    ).catch((err: Error) => {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
    });
  }
  console.log(`${dryRun ? 'Would write' : 'Wrote'} ${todo.length} connections.`);
}
