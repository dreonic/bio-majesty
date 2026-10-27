/**
 * Curated model catalog shown in Settings → AI models.
 *
 * Model references use the AI SDK provider-registry format `provider:modelId`.
 * Anything not listed here can still be used through the "custom model id"
 * field (e.g. `openrouter:deepseek/deepseek-chat`), as long as the provider has
 * an API key configured.
 */

export const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
};

/** Key names expected in the API keys parameter (and env vars for local scripts). */
export const PROVIDER_SECRET_KEYS: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export type ModelTier = 'frontier' | 'flagship' | 'balanced' | 'fast';

export interface CatalogModel {
  id: string;
  provider: ProviderId;
  label: string;
  tier: ModelTier;
  /** Indicative list price (input / output per million tokens), if known. */
  price?: string;
  notes?: string;
}

export const LANGUAGE_MODELS: readonly CatalogModel[] = [
  {
    id: 'anthropic:claude-opus-5-5',
    provider: 'anthropic',
    label: 'Claude Opus 5.5',
    tier: 'flagship',
    price: '$4 / $20',
    notes: 'Default. Best judgment on nuanced sentiment.',
  },
  {
    id: 'anthropic:claude-sonnet-5-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5.5',
    tier: 'balanced',
    price: '$2 / $10',
  },
  {
    id: 'anthropic:claude-haiku-5-5',
    provider: 'anthropic',
    label: 'Claude Haiku 5.5',
    tier: 'fast',
    price: '$0.10 / $0.50',
    notes: 'Cheapest option for bulk tagging.',
  },
  {
    id: 'anthropic:claude-fable-5-1',
    provider: 'anthropic',
    label: 'Claude Fable 5.1',
    tier: 'frontier',
    price: '$10 / $50',
  },
  { id: 'openai:gpt-6-astra', provider: 'openai', label: 'GPT-6 Astra', tier: 'flagship' },
  { id: 'openai:gpt-6-luna', provider: 'openai', label: 'GPT-6 Luna', tier: 'fast' },
  { id: 'google:gemini-4-argon', provider: 'google', label: 'Gemini 4 Argon', tier: 'flagship' },
  { id: 'google:gemini-3.8-flash', provider: 'google', label: 'Gemini 3.8 Flash', tier: 'fast' },
];

export interface CatalogEmbeddingModel {
  id: string;
  provider: ProviderId;
  label: string;
  /** Output dimensions supported by the model (first entry is our default). */
  dimensions: number[];
}

/**
 * Embedding models. Changing the embedding model requires re-indexing every
 * saved article, so it is a deploy-time setting (CDK context), not a dropdown.
 */
export const EMBEDDING_MODELS: readonly CatalogEmbeddingModel[] = [
  { id: 'google:gemini-embedding-2', provider: 'google', label: 'Gemini Embedding 2', dimensions: [768, 1536, 3072] },
  { id: 'google:gemini-embedding-001', provider: 'google', label: 'Gemini Embedding 001', dimensions: [768, 1536, 3072] },
  { id: 'openai:text-embedding-3-small', provider: 'openai', label: 'OpenAI text-embedding-3-small', dimensions: [1536, 512] },
  { id: 'openai:text-embedding-3-large', provider: 'openai', label: 'OpenAI text-embedding-3-large', dimensions: [1024, 3072] },
];

export const DEFAULT_EMBEDDING_MODEL = 'google:gemini-embedding-2';
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/** Split `provider:modelId` into its parts. Returns null when malformed. */
export function parseModelRef(ref: string): { provider: string; modelId: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

export function isKnownProvider(p: string): p is ProviderId {
  return (PROVIDERS as readonly string[]).includes(p);
}
