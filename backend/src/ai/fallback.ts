import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { errorMessage, logger } from '../lib/logger';
import { languageModel } from './registry';

type Model = Awaited<ReturnType<typeof languageModel>>;

/**
 * Wrap a model so that a request that fails before any output is produced is
 * retried once on the fallback model (used by the streaming chat, where
 * `runStructured`'s retry loop does not apply).
 */
export function withFallback(primary: Model, fallback: Model, fallbackRef: string): Model {
  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v4',
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream();
      } catch (err) {
        logger.warn('Primary chat model failed; using fallback', { fallbackRef, error: errorMessage(err) });
        return fallback.doStream(params);
      }
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (err) {
        logger.warn('Primary model failed; using fallback', { fallbackRef, error: errorMessage(err) });
        return fallback.doGenerate(params);
      }
    },
  };
  return wrapLanguageModel({ model: primary, middleware }) as Model;
}

export async function resolveWithFallback(modelRef: string, fallbackRef: string | null): Promise<Model> {
  const primary = await languageModel(modelRef);
  if (!fallbackRef || fallbackRef === modelRef) return primary;
  try {
    return withFallback(primary, await languageModel(fallbackRef), fallbackRef);
  } catch (err) {
    logger.warn('Fallback model unavailable', { fallbackRef, error: errorMessage(err) });
    return primary;
  }
}
