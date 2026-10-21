/**
 * One-off: move the data stored before accounts existed (one shared desk) into one account,
 * the exec's. Run it right after deploying the per-account version: until then the exec's
 * account looks like a new one (defaults, no categories, an empty desk).
 *
 * Usage (needs AWS credentials; `--function` reads TABLE_NAME, DATA_BUCKET, VECTOR_* and
 * USER_POOL_ID from a deployed Lambda, e.g. the StockIngestFunction stack output):
 *   AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:accounts -w backend -- \
 *     --function <StockIngestFunction> --email exec@company.co.id --backup-dir ./backup [--dry-run]
 *   ... --sub <sub>     instead of --email (the User ID in the Cognito console)
 *   ... --cleanup       later, once all is well: delete the old shared items (asks for --yes)
 *
 * What a migration does:
 *  1. Copies the extracted article texts to users/<sub>/articles/.
 *  2. Copies articles (status, tags, edits, with their dedupe keys), dedupe keys, categories,
 *     settings (+ the default profile, stock.symbols = [old symbol], quarter-hour run time),
 *     the Telegram link, runs, digests, feedback and volume alerts into USER#<sub>. The DynamoDB
 *     stream re-indexes the saved articles for chat under the account's vector keys.
 *  3. Deletes the old vector keys (<articleId>#<n>).
 *  4. With --backup-dir: writes every stored 15-minute bar to a CSV per symbol, then gives the
 *     bars of the last 10 days their expiry and deletes the older ones. The market-data source
 *     only serves the last 60 days, so those older bars exist only in the backup afterwards.
 * The old shared items stay (to roll back) until --cleanup.
 */
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CopyObjectCommand, DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteVectorsCommand, S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { BatchWriteCommand, ScanCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { stockCsv, type Candle } from '@bio-majesty/shared';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/lib/env';
import { accountItems, legacyItems, type Item, type LegacyItems } from '../src/migrate/legacy';
import { chunk, ddb, table } from '../src/repo/client';
import { accountPk } from '../src/repo/keys';
import { INTRADAY_RETENTION_DAYS } from '../src/repo/stock';
import { listKeys } from '../src/storage/s3';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');
const backupDir = opt('--backup-dir');

function usage(message: string): never {
  console.error(`${message}\nUsage: npm run migrate:accounts -w backend -- --function <StockIngestFunction> (--email <email> | --sub <sub>) [--backup-dir <dir>] [--dry-run] [--cleanup --yes]`);
  process.exit(1);
}

/** Take the stack's resource names from a deployed function's environment. */
async function loadEnv(functionName: string): Promise<void> {
  const res = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  for (const [k, v] of Object.entries(res.Environment?.Variables ?? {})) process.env[k] ??= v;
}

async function subForEmail(email: string): Promise<string> {
  const res = await new CognitoIdentityProviderClient({}).send(
    new ListUsersCommand({ UserPoolId: env.userPoolId, Filter: `email = "${email.replaceAll('"', '')}"` }),
  );
  const subs = (res.Users ?? []).map((u) => ({ user: u.Username, sub: u.Attributes?.find((a) => a.Name === 'sub')?.Value }));
  if (subs.length !== 1 || !subs[0]!.sub) {
    usage(`Expected one Cognito user with email ${email}, found ${subs.length}${subs.length ? `: ${subs.map((s) => `${s.user} (${s.sub})`).join(', ')}` : ''}. Pass --sub instead.`);
  }
  return subs[0]!.sub!;
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

const pk = (i: Item) => String(i.PK);

async function migrate(sub: string, old: LegacyItems): Promise<void> {
  // 1. Texts first: the stream re-indexes saved articles as soon as their copies are written.
  const s3 = new S3Client({});
  const texts = await listKeys('articles/');
  if (!dryRun) {
    for (const key of texts) {
      await s3.send(new CopyObjectCommand({ Bucket: env.dataBucket, CopySource: `${env.dataBucket}/${key}`, Key: `users/${sub}/${key}` }));
    }
  }
  console.log(`Article texts copied: ${texts.length}`);

  // 2. DynamoDB items.
  const items = accountItems(sub, old);
  await batch(items.map((Item) => ({ PutRequest: { Item } })));
  const settings = items.find((i) => i.SK === 'SETTINGS')?.data as { stock: { symbols: string[] }; schedule: { dailyTime: string } };
  const saved = old.articles.filter((a) => a.status === 'APPROVED').length;
  console.log(
    `Copied into ${accountPk(sub)}: ${old.articles.length} articles (${saved} saved, re-indexed by the stream), ${old.aliases.length} dedupe keys, ` +
      `${old.categories.length} categories, ${old.runs.length} runs, ${old.digests.length} digests, ${old.feedback.length} decisions, ` +
      `${old.anomalies.length} volume alerts, settings (assets: ${settings.stock.symbols.join(', ')}; runs at ${settings.schedule.dailyTime})` +
      `${old.telegram?.chatId ? ', the Telegram link' : ''}.`,
  );

  // 3. Old vector keys (<articleId>#<n>); the stream writes the new ones.
  const vectors = new S3VectorsClient({});
  const oldKeys = old.articles.flatMap((a) => Array.from({ length: 64 }, (_, n) => `${pk(a).replace(/^ART#/, '')}#${n}`));
  if (!dryRun) {
    for (const part of chunk(oldKeys, 100)) {
      await vectors.send(new DeleteVectorsCommand({ vectorBucketName: env.vectorBucket, indexName: env.vectorIndex, keys: part }));
    }
  }
  console.log(`Old vector keys deleted for ${old.articles.length} articles.`);

  // 4. 15-minute bars: back up, keep the last 10 days (with an expiry), delete the rest.
  if (!backupDir) {
    console.log(`Stored 15-minute bars left as they are (${old.intraday.length}); pass --backup-dir to back them up and trim them.`);
    return;
  }
  if (!dryRun) await mkdir(backupDir, { recursive: true });
  const bySymbol = new Map<string, Item[]>();
  for (const bar of old.intraday) bySymbol.set(pk(bar).replace(/^STOCK#/, ''), [...(bySymbol.get(pk(bar).replace(/^STOCK#/, '')) ?? []), bar]);
  const cutoff = Date.now() / 1000 - INTRADAY_RETENTION_DAYS * 86_400;
  for (const [symbol, bars] of bySymbol) {
    const candles = bars.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }) as Candle);
    const csv = stockCsv(symbol, '15m', candles, env.timeZone);
    const file = path.join(backupDir, csv.filename.replace('.csv', '_backup.csv'));
    if (!dryRun) await writeFile(file, csv.csv, 'utf8');
    const keep = bars.filter((b) => Number(b.time) >= cutoff);
    const drop = bars.filter((b) => Number(b.time) < cutoff);
    await batch(keep.map((b) => ({ PutRequest: { Item: { ...b, expiresAt: Number(b.time) + INTRADAY_RETENTION_DAYS * 86_400 } } })));
    await batch(drop.map((b) => ({ DeleteRequest: { Key: { PK: b.PK, SK: b.SK } } })));
    console.log(`${symbol}: ${csv.rows} 15-minute bars backed up to ${file}; kept ${keep.length}, deleted ${drop.length}.`);
  }
}

async function removeShared(old: LegacyItems): Promise<void> {
  if (!args.includes('--yes') && !dryRun) usage('--cleanup deletes the old shared items for good: add --yes (or --dry-run to see the counts).');
  const items = [
    ...old.articles,
    ...old.aliases,
    ...old.categories,
    ...old.runs,
    ...old.digests,
    ...old.feedback,
    ...old.anomalies,
    ...[old.settings, old.telegram].filter((i): i is Item => Boolean(i)),
  ];
  await batch(items.map((i) => ({ DeleteRequest: { Key: { PK: i.PK, SK: i.SK } } })));
  const texts = await listKeys('articles/');
  if (!dryRun) {
    const s3 = new S3Client({});
    for (const part of chunk(texts, 1000)) {
      await s3.send(new DeleteObjectsCommand({ Bucket: env.dataBucket, Delete: { Objects: part.map((Key) => ({ Key })), Quiet: true } }));
    }
  }
  console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${items.length} old shared items and ${texts.length} old article texts.`);
}

const fn = opt('--function');
if (fn) await loadEnv(fn);
const email = opt('--email');
const sub = cleanup ? undefined : (opt('--sub') ?? (email ? await subForEmail(email) : usage('Pass --email or --sub')));
const old = legacyItems(await scanAll());
if (dryRun) console.log('Dry run: nothing is written.');
if (cleanup) await removeShared(old);
else {
  console.log(`Migrating the shared desk into account ${sub} (${accountPk(sub!)}).`);
  await migrate(sub!, old);
  console.log('Done. Make sure this account is in the dashboard-users group (background runs only work for members).');
}
