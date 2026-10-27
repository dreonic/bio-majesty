import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { env } from './env';
import { logger } from './logger';

/**
 * All third-party credentials live in one encrypted SSM parameter (SecureString) per stage, a JSON
 * object such as {"ANTHROPIC_API_KEY": "...", "GOOGLE_GENERATIVE_AI_API_KEY": "...", "TELEGRAM_BOT_TOKEN": "..."}.
 * It is created by hand (CloudFormation can't create SecureStrings), so until it exists there are no keys.
 * Local scripts fall back to environment variables of the same names.
 */
export type SecretBag = Record<string, string | undefined>;

const TTL_MS = 5 * 60 * 1000;
let cache: { value: SecretBag; expires: number } | undefined;
let client: SSMClient | undefined;

export async function getSecrets(): Promise<SecretBag> {
  if (cache && cache.expires > Date.now()) return cache.value;

  let fromSecret: SecretBag = {};
  if (env.apiKeysParameter) {
    client ??= new SSMClient({});
    try {
      const res = await client.send(new GetParameterCommand({ Name: env.apiKeysParameter, WithDecryption: true }));
      fromSecret = res.Parameter?.Value ? (JSON.parse(res.Parameter.Value) as SecretBag) : {};
    } catch (err) {
      if ((err as Error).name !== 'ParameterNotFound') {
        logger.error('Failed to read the API keys', { err });
        throw err;
      }
      logger.warn('The API keys parameter does not exist yet: no provider keys or Telegram token', { name: env.apiKeysParameter });
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
