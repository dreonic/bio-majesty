/**
 * One-off: accounts become profiles. Everything an account owned (partition USER#<sub>, objects
 * under users/<sub>/ and chats/<sub>/, chat vectors keyed <sub>#…) is copied to the account's first
 * profile (PROFILE#<id>, profiles/<id>/…, vectors keyed <id>#… with the profile as owner), named
 * after its subject. Settings get `subject` for `profile`; the single Telegram link item, queries'
 * `lang` and backfills' `months` (left for the earlier migrations' cleanups) are dropped.
 *
 * The old layout stays until --cleanup, so run it right before the deploy and again right after:
 * a repeated run only adds what is missing, so it never overwrites what the new version changed
 * meanwhile (changes the old version made to already-copied items in between are not carried
 * over). After the deploy, --schedules creates each profile's daily-run schedule (it needs the
 * new stack's schedule group). Once all is well, --cleanup --yes deletes the old layout.
 *
 * Usage (needs AWS credentials; `--function` reads the stack's resource names from a deployed
 * Lambda: the StockIngestFunction stack output before the deploy, ProfilesFunction after it):
 *   AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:profiles -w backend -- \
 *     --function <name> [--dry-run] [--schedules] [--cleanup --yes]
 */
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CopyObjectCommand, HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteVectorsCommand,
  ListVectorsCommand,
  PutVectorsCommand,
  S3VectorsClient,
  type ListOutputVector,
  type PutInputVector,
} from '@aws-sdk/client-s3vectors';
import { PutCommand, ScanCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { env } from '../src/lib/env';
import { putDailySchedule } from '../src/lib/schedules';
import { groupByAccount, migratedProfileId, profileItems, profileName, profileObjectKey, profileRecords, profileVectorKey, type Item } from '../src/migrate/profiles';
import { chunk, ddb, table } from '../src/repo/client';
import { asProfileId } from '../src/repo/keys';
import { deletePartition } from '../src/repo/profile-data';
import { getSettings } from '../src/repo/settings';
import { deleteObjects, listKeys } from '../src/storage/s3';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');
const schedules = args.includes('--schedules');
if (cleanup && !dryRun && !args.includes('--yes')) throw new Error('--cleanup deletes the old layout: add --yes (or --dry-run first)');

const s3 = new S3Client({});
const vectors = new S3VectorsClient({});

/** Take the stack's resource names from a deployed function's environment. */
async function loadEnv(functionName: string): Promise<void> {
  const res = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  for (const [k, v] of Object.entries(res.Environment?.Variables ?? {})) process.env[k] ??= v;
}

async function scan(prefix: string, skPrefix?: string): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const res: ScanCommandOutput = await ddb().send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: skPrefix ? 'begins_with(PK, :pk) AND begins_with(SK, :sk)' : 'begins_with(PK, :pk)',
        ExpressionAttributeValues: { ':pk': prefix, ...(skPrefix ? { ':sk': skPrefix } : {}) },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** Put an item unless its key exists. True if written. */
async function putIfMissing(item: Item): Promise<boolean> {
  if (dryRun) return true;
  try {
    await ddb().send(new PutCommand({ TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.dataBucket, Key: key }));
    return true;
  } catch (err) {
    if (err instanceof NotFound || (err as Error).name === 'NotFound') return false;
    throw err;
  }
}

/** Every vector of the index (with data and metadata when asked). */
async function listVectors(withData: boolean): Promise<ListOutputVector[]> {
  const out: ListOutputVector[] = [];
  let token: string | undefined;
  do {
    const res = await vectors.send(
      new ListVectorsCommand({ vectorBucketName: env.vectorBucket, indexName: env.vectorIndex, returnData: withData, returnMetadata: withData, nextToken: token }),
    );
    out.push(...(res.vectors ?? []));
    token = res.nextToken;
  } while (token);
  return out;
}

const fn = opt('--function');
if (fn) await loadEnv(fn);
if (dryRun) console.log('Dry run: nothing is written or deleted.');

if (schedules) {
  // Every profile's daily-run schedule, from its run time (an update for profiles that have one).
  const listed = await scan('ACCOUNT#', 'PROFILE#');
  for (const item of listed) {
    const profileId = asProfileId(String(item.id));
    const { schedule } = await getSettings(profileId);
    if (!dryRun) await putDailySchedule(profileId, schedule);
    console.log(`${String(item.name)} (${profileId}): ${schedule.enabled ? `daily at ${schedule.dailyTime}` : 'disabled'}`);
  }
  console.log(`${dryRun ? 'Would schedule' : 'Scheduled'} ${listed.length} profile(s).`);
  process.exit(0);
}

const accounts = groupByAccount(await scan('USER#'));
const profiles = new Map([...accounts.keys()].map((sub) => [sub, migratedProfileId(sub)]));

if (cleanup) {
  // Old layout of the accounts whose profile exists; vectors and objects first, so a repeated run still finds the accounts.
  const migrated = new Set((await scan('ACCOUNT#', 'PROFILE#')).map((i) => String(i.PK).slice('ACCOUNT#'.length)));
  const subs = [...accounts.keys()].filter((sub) => migrated.has(sub) || console.log(`Skipping ${sub}: no profile yet (copy first)`));
  const oldVectors = (await listVectors(false)).map((v) => v.key!).filter((key) => subs.some((sub) => key.startsWith(`${sub}#`)));
  for (const batch of chunk(dryRun ? [] : oldVectors, 100)) {
    await vectors.send(new DeleteVectorsCommand({ vectorBucketName: env.vectorBucket, indexName: env.vectorIndex, keys: batch }));
  }
  const oldObjects = (await Promise.all(subs.flatMap((sub) => [listKeys(`users/${sub}/`), listKeys(`chats/${sub}/`)]))).flat();
  if (!dryRun && oldObjects.length) await deleteObjects(oldObjects);
  let items = 0;
  for (const sub of subs) items += dryRun ? accounts.get(sub)!.length : await deletePartition(`USER#${sub}`);
  console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${items} items, ${oldObjects.length} objects and ${oldVectors.length} vectors of ${subs.length} account(s).`);
  process.exit(0);
}

const allVectors = await listVectors(true);
for (const [sub, items] of accounts) {
  const profileId = profiles.get(sub)!;
  const name = profileName(items);
  for (const record of profileRecords(sub, profileId, name, new Date().toISOString())) await putIfMissing(record);

  let written = 0;
  const copies = profileItems(items, sub, profileId);
  for (const batch of chunk(copies, 10)) written += (await Promise.all(batch.map(putIfMissing))).filter(Boolean).length;

  let copied = 0;
  const objects = (await Promise.all([listKeys(`users/${sub}/articles/`), listKeys(`chats/${sub}/`)])).flat();
  for (const key of objects) {
    const target = profileObjectKey(key, sub, profileId);
    if (!target || (await objectExists(target))) continue;
    if (!dryRun) await s3.send(new CopyObjectCommand({ Bucket: env.dataBucket, CopySource: `${env.dataBucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`, Key: target }));
    copied++;
  }

  // The indexer only sees the profile's articles once the new version runs: copy the vectors (no re-embedding).
  const own = allVectors.flatMap((v): PutInputVector[] => {
    const key = v.key ? profileVectorKey(v.key, sub, profileId) : null;
    if (!key || !v.data) return [];
    return [{ key, data: v.data, metadata: { ...(v.metadata as Item), owner: profileId } as PutInputVector['metadata'] }];
  });
  for (const batch of chunk(dryRun ? [] : own, 100)) {
    await vectors.send(new PutVectorsCommand({ vectorBucketName: env.vectorBucket, indexName: env.vectorIndex, vectors: batch }));
  }

  console.log(
    `${sub} → profile "${name}" (${profileId}): ${written} of ${copies.length} items ${dryRun ? 'to copy' : 'copied'} (the rest were there already), ` +
      `${copied} of ${objects.length} objects, ${own.length} vectors`,
  );
}
console.log(`${accounts.size} account(s). After the deploy: --schedules with the ProfilesFunction; later --cleanup --yes.`);
