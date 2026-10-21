import { BatchGetCommand, BatchWriteCommand, GetCommand, PutCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { candleDate, dateInZone, type Candle, type Quote, type StockAsset, type VolumeAnomaly } from '@bio-majesty/shared';
import { chunk, ddb, stripKeys, table } from './client';
import { accountPk, keys } from './keys';

/**
 * Intraday bars are kept long enough for the 1D and 5D charts (the last 8 days), then expire.
 * The intraday CSV download asks the market-data source instead.
 */
export const INTRADAY_RETENTION_DAYS = 10;

/** Refresh state of one symbol's market data (shared by every account tracking it). */
export interface StockStatus {
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Set once the full daily history has been loaded. */
  historyLoadedAt: string | null;
  /** Trading date (asset calendar) whose end-of-day refresh is done. */
  eodDoneFor: string | null;
}

/** Daily bars are keyed by trading date: `time` is 00:00 UTC of that date. */
export async function putDailyCandles(symbol: string, candles: Candle[]): Promise<void> {
  const items = candles.map((c) => ({
    PutRequest: { Item: { ...keys.stockDaily(symbol, candleDate(c.time)), ...c } },
  }));
  await batchWrite(items);
}

export async function putIntradayCandles(symbol: string, candles: Candle[]): Promise<void> {
  const items = candles.map((c) => ({
    PutRequest: { Item: { ...keys.stockIntraday(symbol, c.time), ...c, expiresAt: c.time + INTRADAY_RETENTION_DAYS * 86_400 } },
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

async function queryRange(symbol: string, fromSk: string, toSk: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': `STOCK#${symbol}`, ':a': fromSk, ':b': toSk },
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
export function queryDaily(symbol: string, from: Date, to: Date, timeZone: string): Promise<Candle[]> {
  return queryRange(symbol, `D#${dateInZone(timeZone, from)}`, `D#${dateInZone(timeZone, to)}`);
}

export function queryIntraday(symbol: string, from: Date, to: Date): Promise<Candle[]> {
  const a = Math.floor(from.getTime() / 1000);
  const b = Math.floor(to.getTime() / 1000);
  return queryRange(symbol, keys.stockIntraday(symbol, a).SK, keys.stockIntraday(symbol, b).SK);
}

export async function putQuote(quote: Quote): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.stockQuote(quote.symbol), ...quote } }));
}

export async function getQuote(symbol: string): Promise<Quote | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.stockQuote(symbol) }));
  return res.Item ? (stripKeys(res.Item) as unknown as Quote) : null;
}

export async function getStockStatus(symbol: string): Promise<StockStatus> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.stockStatus(symbol) }));
  return {
    lastSuccessAt: (res.Item?.lastSuccessAt as string | undefined) ?? null,
    lastError: (res.Item?.lastError as string | undefined) ?? null,
    consecutiveFailures: Number(res.Item?.consecutiveFailures ?? 0),
    historyLoadedAt: (res.Item?.historyLoadedAt as string | undefined) ?? null,
    eodDoneFor: (res.Item?.eodDoneFor as string | undefined) ?? null,
  };
}

export async function putStockStatus(symbol: string, status: StockStatus): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.stockStatus(symbol), ...status } }));
}

export async function getAsset(symbol: string): Promise<StockAsset | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.stockMeta(symbol) }));
  return res.Item ? (stripKeys(res.Item) as unknown as StockAsset) : null;
}

/** Metadata of several symbols, in the order asked (symbols without metadata are left out). */
export async function getAssets(symbols: string[]): Promise<StockAsset[]> {
  const found = new Map<string, StockAsset>();
  for (const batch of chunk([...new Set(symbols)], 100)) {
    let request: Record<string, { Keys: Record<string, unknown>[] }> | undefined = {
      [table()]: { Keys: batch.map((s) => keys.stockMeta(s)) },
    };
    while (request && Object.keys(request).length) {
      const res = await ddb().send(new BatchGetCommand({ RequestItems: request }));
      for (const item of res.Responses?.[table()] ?? []) {
        const asset = stripKeys(item) as unknown as StockAsset;
        found.set(asset.symbol, asset);
      }
      request = res.UnprocessedKeys as typeof request;
    }
  }
  return symbols.map((s) => found.get(s)).filter((a): a is StockAsset => Boolean(a));
}

export async function putAsset(asset: StockAsset): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.stockMeta(asset.symbol), ...asset } }));
}

/** An account's volume alert for one symbol and day (each account has its own ratio and alerts). */
export async function putAnomaly(sub: string, symbol: string, anomaly: VolumeAnomaly): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.anomaly(sub, symbol, anomaly.date), ...anomaly } }));
}

export async function getAnomaly(sub: string, symbol: string, ymd: string): Promise<VolumeAnomaly | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.anomaly(sub, symbol, ymd) }));
  return res.Item ? (stripKeys(res.Item) as unknown as VolumeAnomaly) : null;
}

/** The account's stored (notified) anomalies of a symbol since `fromYmd`, oldest first. */
export async function listAnomalyRecords(sub: string, symbol: string, fromYmd: string): Promise<VolumeAnomaly[]> {
  const out: VolumeAnomaly[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': accountPk(sub), ':a': `ANOMALY#${symbol}#${fromYmd}`, ':b': `ANOMALY#${symbol}#~` },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) out.push(stripKeys(item) as unknown as VolumeAnomaly);
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}
