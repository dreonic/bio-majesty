import { assetId, STOCK_SOURCES, type StockSource } from '@bio-majesty/shared';
import { keys } from '../repo/keys';

/**
 * Assets stored as bare Yahoo symbols ("PRDA.JK", from before assets had a source) renamed to
 * asset IDs ("yahoo:PRDA.JK"), used once by scripts/migrate-asset-ids.ts. Pure: no AWS calls.
 *
 *  - Market data: every item of a `STOCK#<symbol>` partition is copied to `STOCK#<id>`; the
 *    metadata gains `id` and `source`, the quote names its asset instead of a symbol and provider.
 *  - Accounts: settings (`stock.symbols` -> `stock.assets`, `profile.sentimentSymbol` ->
 *    `profile.sentimentAsset`) and volume alerts (`ANOMALY#<symbol>#<date>` -> `ANOMALY#<id>#<date>`).
 *
 * A symbol's source is the provider its stored quote came from (Yahoo when unknown). Items the new
 * version already wrote are kept as they are. Old items are only deleted by the cleanup.
 */

export type Item = Record<string, unknown>;

const pk = (i: Item) => String(i.PK);
const sk = (i: Item) => String(i.SK);
const keyOf = (PK: string, SK: string) => `${PK}\n${SK}`;

/** Asset names from before sources existed have no "<source>:" prefix. */
const isBare = (name: string) => !name.includes(':');

export interface OldKey {
  PK: string;
  SK: string;
  /** Whether the item's copy under the new key exists: the cleanup only deletes those. */
  copied: boolean;
}

export interface AssetIdMigration {
  /** Items to put: copies under the new keys, and settings rewritten in place. */
  puts: Item[];
  /** The settings items as stored now (what the rewrite replaces), for a backup. */
  replacedSettings: Item[];
  /** Items under the old keys, for the cleanup. */
  oldKeys: OldKey[];
  /** Old symbol -> asset ID. */
  ids: Map<string, string>;
  counts: { marketData: number; settings: number; anomalies: number };
}

export function planAssetIdMigration(items: Item[]): AssetIdMigration {
  const existing = new Set(items.map((i) => keyOf(pk(i), sk(i))));
  const sources = new Map<string, StockSource>();
  for (const i of items) {
    const symbol = pk(i).slice('STOCK#'.length);
    if (!pk(i).startsWith('STOCK#') || sk(i) !== 'QUOTE' || !isBare(symbol)) continue;
    const provider = String(i.provider ?? '');
    sources.set(symbol, (STOCK_SOURCES as readonly string[]).includes(provider) ? (provider as StockSource) : 'yahoo');
  }
  const ids = new Map<string, string>();
  const idOf = (symbol: string) => {
    let id = ids.get(symbol);
    if (!id) ids.set(symbol, (id = assetId(sources.get(symbol) ?? 'yahoo', symbol)));
    return id;
  };

  const plan: AssetIdMigration = { puts: [], replacedSettings: [], oldKeys: [], ids, counts: { marketData: 0, settings: 0, anomalies: 0 } };
  /** Copy an item to its new key, unless an item is there already (copied before, or written by the new version). */
  const copy = (item: Item, next: Item, kind: 'marketData' | 'anomalies') => {
    const copied = existing.has(keyOf(pk(next), sk(next)));
    plan.oldKeys.push({ PK: pk(item), SK: sk(item), copied });
    if (copied) return;
    plan.puts.push(next);
    plan.counts[kind]++;
  };

  for (const i of items) {
    if (pk(i).startsWith('STOCK#')) {
      const symbol = pk(i).slice('STOCK#'.length);
      if (!isBare(symbol)) continue;
      const id = idOf(symbol);
      copy(i, marketItem({ ...i, PK: `STOCK#${id}` }, id), 'marketData');
    } else if (pk(i).startsWith('USER#') && sk(i).startsWith('ANOMALY#')) {
      const rest = sk(i).slice('ANOMALY#'.length);
      const cut = rest.lastIndexOf('#');
      const symbol = rest.slice(0, cut);
      if (!isBare(symbol)) continue;
      copy(i, { ...i, ...keys.anomaly(pk(i).slice('USER#'.length), idOf(symbol), rest.slice(cut + 1)) }, 'anomalies');
    } else if (pk(i).startsWith('USER#') && sk(i) === 'SETTINGS') {
      const next = settingsItem(i, idOf);
      if (!next) continue;
      plan.replacedSettings.push(i);
      plan.puts.push(next);
      plan.counts.settings++;
    }
  }
  return plan;
}

/** A market-data item under its asset ID: metadata gains `id` and `source`; the quote names its asset. */
function marketItem(item: Item, id: string): Item {
  if (sk(item) === 'META') return { ...item, id, source: id.slice(0, id.indexOf(':')) };
  if (sk(item) === 'QUOTE') {
    const { symbol: _symbol, provider: _provider, ...quote } = item;
    return { ...quote, asset: id };
  }
  return item;
}

/** Settings naming bare symbols, renamed to asset IDs; null when there is nothing to rename. */
function settingsItem(item: Item, idOf: (symbol: string) => string): Item | null {
  const data = (item.data ?? {}) as { stock?: Item; profile?: Item };
  const { symbols, ...stock } = data.stock ?? {};
  const { sentimentSymbol, ...profile } = data.profile ?? {};
  const hasSymbols = Array.isArray(symbols);
  const hasSentiment = data.profile !== undefined && 'sentimentSymbol' in data.profile;
  if (!hasSymbols && !hasSentiment) return null;
  return {
    ...item,
    data: {
      ...data,
      ...(data.stock && { stock: { ...stock, ...(hasSymbols && { assets: [...new Set((symbols as string[]).map(idOf))] }) } }),
      ...(data.profile && { profile: { ...profile, ...(hasSentiment && { sentimentAsset: sentimentSymbol ? idOf(String(sentimentSymbol)) : null }) } }),
    },
  };
}
