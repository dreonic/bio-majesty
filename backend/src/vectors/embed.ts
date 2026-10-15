import { embed, embedMany } from 'ai';
import { embeddingModel } from '../ai/registry';
import type { UsageCollector } from '../ai/usage';
import { env } from '../lib/env';

type Purpose = 'document' | 'query';

/** Provider-specific embedding options (task type and output size). */
function providerOptions(modelRef: string, purpose: Purpose, dimensions: number) {
  const provider = modelRef.slice(0, modelRef.indexOf(':'));
  if (provider === 'google') {
    return {
      google: {
        outputDimensionality: dimensions,
        taskType: purpose === 'document' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY',
      },
    };
  }
  if (provider === 'openai') return { openai: { dimensions } };
  return undefined;
}

export async function embedDocuments(texts: string[], usage?: UsageCollector): Promise<number[][]> {
  if (!texts.length) return [];
  const ref = env.embeddingModel;
  const result = await embedMany({
    model: await embeddingModel(ref),
    values: texts,
    providerOptions: providerOptions(ref, 'document', env.embeddingDimensions) as never,
    maxRetries: 3,
  });
  usage?.add('embedding', ref, { inputTokens: result.usage?.tokens ?? 0, outputTokens: 0 });
  return result.embeddings;
}

export async function embedQuery(text: string): Promise<number[]> {
  const ref = env.embeddingModel;
  const result = await embed({
    model: await embeddingModel(ref),
    value: text,
    providerOptions: providerOptions(ref, 'query', env.embeddingDimensions) as never,
    maxRetries: 2,
  });
  return result.embedding;
}
