import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  PROVIDER_SECRET_KEYS,
  PROVIDERS,
  isKnownProvider,
  parseModelRef,
  type ProviderId,
} from '@bio-majesty/shared';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createProviderRegistry } from 'ai';
import { createHash } from 'node:crypto';
import { getSecrets } from '../lib/secrets';

type ProviderMap = Parameters<typeof createProviderRegistry>[0];
type Registry = ReturnType<typeof createProviderRegistry>;

export class ModelConfigError extends Error {}

let cached: { signature: string; registry: Registry; configured: ProviderId[] } | undefined;

/**
 * Provider registry built from whichever API keys are present in Secrets
 * Manager. Rebuilt automatically when keys change (secrets are cached 5 min).
 */
export async function getModelAccess(): Promise<{ registry: Registry; configured: ProviderId[] }> {
  const secrets = await getSecrets();
  const keysByProvider = Object.fromEntries(
    PROVIDERS.map((p) => [p, secrets[PROVIDER_SECRET_KEYS[p]]]),
  ) as Record<ProviderId, string | undefined>;
  const signature = createHash('sha256').update(JSON.stringify(keysByProvider)).digest('hex');
  if (cached?.signature === signature) return cached;

  const providers: ProviderMap = {};
  const configured: ProviderId[] = [];
  if (keysByProvider.anthropic) {
    providers.anthropic = createAnthropic({ apiKey: keysByProvider.anthropic });
    configured.push('anthropic');
  }
  if (keysByProvider.openai) {
    providers.openai = createOpenAI({ apiKey: keysByProvider.openai });
    configured.push('openai');
  }
  if (keysByProvider.google) {
    providers.google = createGoogle({ apiKey: keysByProvider.google });
    configured.push('google');
  }
  if (keysByProvider.openrouter) {
    providers.openrouter = createOpenRouter({ apiKey: keysByProvider.openrouter });
    configured.push('openrouter');
  }

  cached = { signature, registry: createProviderRegistry(providers), configured };
  return cached;
}

export async function configuredProviders(): Promise<ProviderId[]> {
  return (await getModelAccess()).configured;
}

function assertUsable(ref: string, configured: ProviderId[]): `${string}:${string}` {
  const parsed = parseModelRef(ref);
  if (!parsed) throw new ModelConfigError(`Invalid model reference "${ref}" (expected provider:modelId)`);
  if (!isKnownProvider(parsed.provider)) throw new ModelConfigError(`Unknown provider "${parsed.provider}"`);
  if (!configured.includes(parsed.provider)) {
    throw new ModelConfigError(
      `No API key configured for ${parsed.provider}. Add ${PROVIDER_SECRET_KEYS[parsed.provider]} to the secret.`,
    );
  }
  return ref as `${string}:${string}`;
}

export async function languageModel(ref: string) {
  const { registry, configured } = await getModelAccess();
  return registry.languageModel(assertUsable(ref, configured) as never);
}

export async function embeddingModel(ref: string) {
  const { registry, configured } = await getModelAccess();
  return registry.embeddingModel(assertUsable(ref, configured) as never);
}

/** Test hook. */
export function resetRegistryCache(): void {
  cached = undefined;
}
