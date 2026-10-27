/**
 * Digests stored before they had an overall sentiment, given `overall: null` ("not judged"), used
 * once by scripts/migrate-digest-overall.ts. Pure: no AWS calls.
 */

export type Item = Record<string, unknown>;

/** Keys of the accounts' digest items that have no `overall` attribute yet. */
export function planDigestOverall(items: Item[]): { PK: string; SK: string }[] {
  return items
    .filter((i) => String(i.PK).startsWith('USER#') && String(i.SK).startsWith('DIGEST#') && !('overall' in i))
    .map((i) => ({ PK: String(i.PK), SK: String(i.SK) }));
}
