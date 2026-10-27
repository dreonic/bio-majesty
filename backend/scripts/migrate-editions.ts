/**
 * One-off: give every stored search query its Google News edition. Queries used to name only a
 * language ("id"/"en", always Google News Indonesia); now they name an edition ("ID:id"/"ID:en",
 * see EDITIONS in shared/src/editions.ts). The run is idempotent and keeps `lang`, so it is safe
 * before and after deploying the version with editions: run it right before pushing that version
 * and again right after its deploy (which picks up categories saved in between).
 *
 * Usage (needs AWS credentials; `--function` reads TABLE_NAME from a deployed Lambda, e.g. the
 * StockIngestFunction stack output):
 *   AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:editions -w backend -- \
 *     --function <StockIngestFunction> --backup-dir ./backup [--dry-run]
 *   ... --cleanup --yes   later, once all is well: remove `lang` from queries that have an edition
 *
 * Every run also lists accounts that have categories but no stored profile subject or asset list:
 * their settings came from the defaults, which used to describe one company and are now blank.
 */
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { BatchWriteCommand, ScanCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { planEditionMigration, planLangCleanup, type Item } from '../src/migrate/editions';
import { chunk, ddb, table } from '../src/repo/client';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');
const backupDir = opt('--backup-dir');

function usage(message: string): never {
  console.error(`${message}\nUsage: npm run migrate:editions -w backend -- --function <StockIngestFunction> [--backup-dir <dir>] [--dry-run] [--cleanup --yes]`);
  process.exit(1);
}

/** Take the stack's resource names from a deployed function's environment. */
async function loadEnv(functionName: string): Promise<void> {
  const res = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  for (const [k, v] of Object.entries(res.Environment?.Variables ?? {})) process.env[k] ??= v;
}

/** The accounts' categories and settings (market data is left out). */
async function scanAccounts(): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const res: ScanCommandOutput = await ddb().send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: 'begins_with(SK, :category) OR SK = :settings',
        ExpressionAttributeValues: { ':category': 'CATEGORY#', ':settings': 'SETTINGS' },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

async function putAll(items: Item[]): Promise<void> {
  if (dryRun) return;
  for (const part of chunk(items, 25)) {
    let request: Record<string, { PutRequest: { Item: Item } }[]> | undefined = { [table()]: part.map((Item) => ({ PutRequest: { Item } })) };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchWriteCommand({ RequestItems: request }));
      request = res.UnprocessedItems as typeof request;
    }
  }
}

async function migrate(items: Item[]): Promise<void> {
  const plan = planEditionMigration(items);
  if (backupDir && plan.replaced.length) {
    const file = path.join(backupDir, `categories_before_editions_${new Date().toISOString().replaceAll(':', '-')}.json`);
    if (!dryRun) {
      await mkdir(backupDir, { recursive: true });
      await writeFile(file, `${JSON.stringify(plan.replaced, null, 2)}\n`, 'utf8');
    }
    console.log(`${plan.replaced.length} categories backed up to ${file}.`);
  }
  await putAll(plan.puts);
  console.log(`${dryRun ? 'Would give' : 'Gave'} ${plan.counts.queries} queries in ${plan.counts.categories} categories their edition.`);
  console.log(
    plan.onDefaults.length
      ? `Accounts with categories but no stored profile subject or asset list (they now get the blank defaults; set them up in Settings): ${plan.onDefaults.join(', ')}`
      : 'Every account with categories has its profile and asset list stored.',
  );
}

async function removeLang(items: Item[]): Promise<void> {
  if (!args.includes('--yes') && !dryRun) usage('--cleanup removes `lang` from the stored queries for good: add --yes (or --dry-run to see the count).');
  const puts = planLangCleanup(items);
  await putAll(puts);
  console.log(`${dryRun ? 'Would remove' : 'Removed'} \`lang\` from the queries of ${puts.length} categories.`);
}

const fn = opt('--function');
if (fn) await loadEnv(fn);
const items = await scanAccounts();
if (dryRun) console.log('Dry run: nothing is written.');
if (cleanup) await removeLang(items);
else await migrate(items);
