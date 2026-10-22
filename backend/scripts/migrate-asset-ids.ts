/**
 * One-off: give every stored asset its source. Assets used to be bare Yahoo symbols ("PRDA.JK");
 * now they are IDs ("yahoo:PRDA.JK", see assetId in shared/src/stock.ts). Run it right after
 * deploying the version with sources, before using the dashboard: until then every account sees
 * only the default asset (yahoo:PRDA.JK), and a settings change saved in between replaces the
 * account's asset list.
 *
 * Usage (needs AWS credentials; `--function` reads TABLE_NAME from a deployed Lambda, e.g. the
 * StockIngestFunction stack output):
 *   AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:asset-ids -w backend -- \
 *     --function <StockIngestFunction> --backup-dir ./backup [--dry-run]
 *   ... --cleanup --yes   later, once all is well: delete the items under the old keys
 *
 * What a migration does (src/migrate/asset-ids.ts has the details):
 *  1. With --backup-dir: writes the settings items it is about to rewrite to a JSON file.
 *  2. Copies each STOCK#<symbol> partition (metadata, quote, status, daily and 15-minute bars) to
 *     STOCK#<source>:<symbol>, and each account's volume alerts to ANOMALY#<source>:<symbol>#<date>.
 *  3. Rewrites each account's settings in place (stock.assets, profile.sentimentAsset).
 * The old market data and volume alerts stay (to roll back) until --cleanup, which deletes only
 * old items whose copy exists.
 */
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { BatchWriteCommand, ScanCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { planAssetIdMigration, type Item } from '../src/migrate/asset-ids';
import { chunk, ddb, table } from '../src/repo/client';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');
const backupDir = opt('--backup-dir');

function usage(message: string): never {
  console.error(`${message}\nUsage: npm run migrate:asset-ids -w backend -- --function <StockIngestFunction> [--backup-dir <dir>] [--dry-run] [--cleanup --yes]`);
  process.exit(1);
}

/** Take the stack's resource names from a deployed function's environment. */
async function loadEnv(functionName: string): Promise<void> {
  const res = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  for (const [k, v] of Object.entries(res.Environment?.Variables ?? {})) process.env[k] ??= v;
}

async function scanAll(): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const res: ScanCommandOutput = await ddb().send(new ScanCommand({ TableName: table(), ExclusiveStartKey: startKey }));
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

async function batch(requests: ({ PutRequest: { Item: Item } } | { DeleteRequest: { Key: Item } })[]): Promise<void> {
  if (dryRun) return;
  for (const part of chunk(requests, 25)) {
    let request: Record<string, typeof part> | undefined = { [table()]: part };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchWriteCommand({ RequestItems: request }));
      request = res.UnprocessedItems as typeof request;
    }
  }
}

async function migrate(plan: ReturnType<typeof planAssetIdMigration>): Promise<void> {
  if (backupDir && plan.replacedSettings.length) {
    const file = path.join(backupDir, `settings_before_asset-ids_${new Date().toISOString().replaceAll(':', '-')}.json`);
    if (!dryRun) {
      await mkdir(backupDir, { recursive: true });
      await writeFile(file, `${JSON.stringify(plan.replacedSettings, null, 2)}\n`, 'utf8');
    }
    console.log(`Settings of ${plan.replacedSettings.length} account(s) backed up to ${file}.`);
  }
  await batch(plan.puts.map((Item) => ({ PutRequest: { Item } })));
  const renamed = [...plan.ids].map(([symbol, id]) => `${symbol} -> ${id}`).join(', ') || 'none';
  console.log(
    `${dryRun ? 'Would write' : 'Wrote'} ${plan.counts.marketData} market-data items, ${plan.counts.anomalies} volume alerts and ` +
      `${plan.counts.settings} account settings. Assets: ${renamed}.`,
  );
}

async function removeOld(plan: ReturnType<typeof planAssetIdMigration>): Promise<void> {
  if (!args.includes('--yes') && !dryRun) usage('--cleanup deletes the items under the old keys for good: add --yes (or --dry-run to see the counts).');
  const done = plan.oldKeys.filter((k) => k.copied);
  const pending = plan.oldKeys.length - done.length;
  await batch(done.map(({ PK, SK }) => ({ DeleteRequest: { Key: { PK, SK } } })));
  console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${done.length} items under the old keys.`);
  if (pending) console.log(`${pending} old items have no copy yet and were kept: run the migration (without --cleanup) first.`);
}

const fn = opt('--function');
if (fn) await loadEnv(fn);
const plan = planAssetIdMigration(await scanAll());
if (dryRun) console.log('Dry run: nothing is written.');
if (cleanup) await removeOld(plan);
else await migrate(plan);
