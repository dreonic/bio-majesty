import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { env } from './env';
import { logger } from './logger';

/**
 * All third-party credentials live in one JSON secret per stage, e.g.
 * {"ANTHROPIC_API_KEY": "...", "GOOGLE_GENERATIVE_AI_API_KEY": "...", "TELEGRAM_BOT_TOKEN": "..."}.
 * Local scripts fall back to environment variables of the same names.
 */
export type SecretBag = Record<string, string | undefined>;

const TTL_MS = 5 * 60 * 1000;
let cache: { value: SecretBag; expires: number } | undefined;
let client: SecretsManagerClient | undefined;

export async function getSecrets(): Promise<SecretBag> {
  if (cache && cache.expires > Date.now()) return cache.value;

  let fromSecret: SecretBag = {};
  if (env.secretArn) {
    client ??= new SecretsManagerClient({});
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: env.secretArn }));
      fromSecret = res.SecretString ? (JSON.parse(res.SecretString) as SecretBag) : {};
    } catch (err) {
      logger.error('Failed to read secrets', { err });
      throw err;
    }
  }

  const value: SecretBag = { ...pickEnv(), ...stripEmpty(fromSecret) };
  cache = { value, expires: Date.now() + TTL_MS };
  return value;
}

export async function getSecret(name: string): Promise<string | undefined> {
  const bag = await getSecrets();
  return bag[name];
}

/** Test hook. */
export function resetSecretsCache(): void {
  cache = undefined;
}

const KNOWN_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'EODHD_API_KEY',
];

function pickEnv(): SecretBag {
  const out: SecretBag = {};
  for (const k of KNOWN_KEYS) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return out;
}

function stripEmpty(bag: SecretBag): SecretBag {
  const out: SecretBag = {};
  for (const [k, v] of Object.entries(bag)) {
    if (typeof v === 'string' && v.trim() !== '' && !v.startsWith('REPLACE_ME')) out[k] = v.trim();
  }
  return out;
}
