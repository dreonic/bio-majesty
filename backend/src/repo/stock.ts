import { BatchGetCommand, BatchWriteCommand, GetCommand, PutCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { candleDate, dateInZone, type Candle, type Quote, type StockAsset, type VolumeAnomaly } from '@bio-majesty/shared';
import { chunk, ddb, stripKeys, table } from './client';
import { keys, profilePk, type ProfileId } from './keys';

/**
 * Intraday bars are kept long enough for the 1D and 5D charts (the last 8 days), then expire.
 * The intraday CSV download asks the market-data source instead.
 */
export const INTRADAY_RETENTION_DAYS = 10;

/** Refresh state of one asset's market data (shared by every profile tracking it). */
export interface StockStatus {
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Set once the full daily history has been loaded. */
  historyLoadedAt: string | null;
  /** Trading date (asset calendar) whose end-of-day refresh is done. */
  eodDoneFor: string | null;
}

/** Daily bars are keyed by trading date: `time` is 00:00 UTC of that date. `asset` is the asset's ID. */
export async function putDailyCandles(asset: string, candles: Candle[]): Promise<void> {
  const items = candles.map((c) => ({
    PutRequest: { Item: { ...keys.stockDaily(asset, candleDate(c.time)), ...c } },
  }));
  await batchWrite(items);
}

export async function putIntradayCandles(asset: string, candles: Candle[]): Promise<void> {
  const items = candles.map((c) => ({
    PutRequest: { Item: { ...keys.stockIntraday(asset, c.time), ...c, expiresAt: c.time + INTRADAY_RETENTION_DAYS * 86_400 } },
  }));
  await batchWrite(items);
}

async function batchWrite(items: { PutRequest: { Item: Record<string, unknown> } }[]): Promise<void> {
  for (const batch of chunk(items, 25)) {
    let request: Record<string, typeof batch> | undefined = { [table()]: batch };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchWriteCommand({ RequestItems: request }));
      request = res.UnprocessedItems as typeof request;
    }
  }
}

async function queryRange(asset: string, fromSk: string, toSk: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': `STOCK#${asset}`, ':a': fromSk, ':b': toSk },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) {
      const { time, open, high, low, close, volume } = item as unknown as Candle;
      out.push({ time, open, high, low, close, volume });
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out.sort((a, b) => a.time - b.time);
}

/** Daily bars whose trading dates (in the asset's `timeZone`) fall between `from` and `to`. */
export function queryDaily(asset: string, from: Date, to: Date, timeZone: string): Promise<Candle[]> {
  return queryRange(asset, `D#${dateInZone(timeZone, from)}`, `D#${dateInZone(timeZone, to)}`);
}

export function queryIntraday(asset: string, from: Date, to: Date): Promise<Candle[]> {
  const a = Math.floor(from.getTime() / 1000);
  const b = Math.floor(to.getTime() / 1000);
  return queryRange(asset, keys.stockIntraday(asset, a).SK, keys.stockIntraday(asset, b).SK);
}

export async function putQuote(quote: Quote): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.stockQuote(quote.asset), ...quote } }));
}

export async function getQuote(asset: string): Promise<Quote | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.stockQuote(asset) }));
  return res.Item ? (stripKeys(res.Item) as unknown as Quote) : null;
}

export async function getStockStatus(asset: string): Promise<StockStatus> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.stockStatus(asset) }));
  return {
    lastSuccessAt: (res.Item?.lastSuccessAt as string | undefined) ?? null,
    lastError: (res.Item?.lastError as string | undefined) ?? null,
    consecutiveFailures: Number(res.Item?.consecutiveFailures ?? 0),
    historyLoadedAt: (res.Item?.historyLoadedAt as string | undefined) ?? null,
    eodDoneFor: (res.Item?.eodDoneFor as string | undefined) ?? null,
  };
}

export async function putStockStatus(asset: string, status: StockStatus): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.stockStatus(asset), ...status } }));
}

export async function getAsset(id: string): Promise<StockAsset | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.stockMeta(id) }));
  return res.Item ? (stripKeys(res.Item) as unknown as StockAsset) : null;
}

/** Metadata of several assets, in the order asked (assets without metadata are left out). */
export async function getAssets(ids: string[]): Promise<StockAsset[]> {
  const found = new Map<string, StockAsset>();
  for (const batch of chunk([...new Set(ids)], 100)) {
    let request: Record<string, { Keys: Record<string, unknown>[] }> | undefined = {
      [table()]: { Keys: batch.map((id) => keys.stockMeta(id)) },
    };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchGetCommand({ RequestItems: request }));
      for (const item of res.Responses?.[table()] ?? []) {
        const asset = stripKeys(item) as unknown as StockAsset;
        found.set(asset.id, asset);
      }
      request = res.UnprocessedKeys as typeof request;
    }
  }
  return ids.map((id) => found.get(id)).filter((a): a is StockAsset => Boolean(a));
}

export async function putAsset(asset: StockAsset): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.stockMeta(asset.id), ...asset } }));
}

/** A profile's volume alert for one asset and day (each profile has its own ratio and alerts). */
export async function putAnomaly(profileId: ProfileId, asset: string, anomaly: VolumeAnomaly): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.anomaly(profileId, asset, anomaly.date), ...anomaly } }));
}

export async function getAnomaly(profileId: ProfileId, asset: string, ymd: string): Promise<VolumeAnomaly | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.anomaly(profileId, asset, ymd) }));
  return res.Item ? (stripKeys(res.Item) as unknown as VolumeAnomaly) : null;
}

/** The profile's stored (notified) anomalies of an asset since `fromYmd`, oldest first. */
export async function listAnomalyRecords(profileId: ProfileId, asset: string, fromYmd: string): Promise<VolumeAnomaly[]> {
  const out: VolumeAnomaly[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': profilePk(profileId), ':a': `ANOMALY#${asset}#${fromYmd}`, ':b': `ANOMALY#${asset}#~` },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) out.push(stripKeys(item) as unknown as VolumeAnomaly);
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}
