import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { Candle, Quote, VolumeAnomaly } from '@bio-majesty/shared';
import { jakartaDate } from '../lib/time';
import { chunk, ddb, stripKeys, table } from './client';
import { keys } from './keys';

export interface StockStatus {
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Set once the full daily history has been loaded. */
  historyLoadedAt: string | null;
}

export async function putDailyCandles(symbol: string, candles: Candle[]): Promise<void> {
  const items = candles.map((c) => ({
    PutRequest: { Item: { ...keys.stockDaily(symbol, jakartaDate(new Date(c.time * 1000))), ...c } },
  }));
  await batchWrite(items);
}

/** 15-minute bars are kept for good (about 5,000 a year): the 15-minute CSV download has them all. */
export async function putIntradayCandles(symbol: string, candles: Candle[]): Promise<void> {
  const items = candles.map((c) => ({
    PutRequest: { Item: { ...keys.stockIntraday(symbol, c.time), ...c } },
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

export function queryDaily(symbol: string, from: Date, to: Date): Promise<Candle[]> {
  return queryRange(symbol, `D#${jakartaDate(from)}`, `D#${jakartaDate(to)}`);
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
  };
}

export async function putStockStatus(symbol: string, status: StockStatus): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.stockStatus(symbol), ...status } }));
}

export async function putAnomaly(symbol: string, anomaly: VolumeAnomaly): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.stockAnomaly(symbol, anomaly.date), ...anomaly } }));
}

export async function getAnomaly(symbol: string, ymd: string): Promise<VolumeAnomaly | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.stockAnomaly(symbol, ymd) }));
  return res.Item ? (stripKeys(res.Item) as unknown as VolumeAnomaly) : null;
}

/** Stored (notified) anomalies since `fromYmd`, oldest first. */
export async function listAnomalyRecords(symbol: string, fromYmd: string): Promise<VolumeAnomaly[]> {
  const out: VolumeAnomaly[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await ddb().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': `STOCK#${symbol}`, ':a': `ANOMALY#${fromYmd}`, ':b': 'ANOMALY#~' },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) out.push(stripKeys(item) as unknown as VolumeAnomaly);
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}
