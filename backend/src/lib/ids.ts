import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Deterministic, URL-safe id derived from arbitrary input (first 120 bits of SHA-256). */
export function hashId(input: string, length = 24): string {
  const digest = createHash('sha256').update(input).digest();
  let out = '';
  for (let i = 0; out.length < length; i++) {
    out += ALPHABET[digest[i % digest.length]! % ALPHABET.length];
  }
  return out;
}

/** Random id, e.g. for runs and link codes. */
export function randomId(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Sortable id: UTC timestamp prefix + random suffix. */
export function timeId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${randomId(6)}`;
}
