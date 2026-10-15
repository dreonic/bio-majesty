import type { AiTask, TaskModelSettings } from '@bio-majesty/shared';
import { APICallError, generateText, Output, type LanguageModelUsage } from 'ai';
import type { z } from 'zod';
import { errorMessage, logger } from '../lib/logger';
import { languageModel, ModelConfigError } from './registry';
import type { UsageCollector } from './usage';

/** Anthropic models that accept server-side refusal fallbacks (`fallbacks: 'default'`). */
const ANTHROPIC_SERVER_FALLBACK_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
]);

/**
 * Provider options applied by default, merged under the user's own options.
 * For supported Claude models we opt into Anthropic's server-side refusal
 * fallback so a safety-classifier block is retried on a fallback model.
 */
export function defaultProviderOptions(modelRef: string): Record<string, Record<string, unknown>> {
  const [provider, modelId] = [modelRef.slice(0, modelRef.indexOf(':')), modelRef.slice(modelRef.indexOf(':') + 1)];
  if (provider === 'anthropic' && ANTHROPIC_SERVER_FALLBACK_MODELS.has(modelId)) {
    return { anthropic: { fallbacks: 'default' } };
  }
  return {};
}

export function mergeProviderOptions(
  modelRef: string,
  user: TaskModelSettings['providerOptions'],
): Record<string, Record<string, unknown>> | undefined {
  const merged: Record<string, Record<string, unknown>> = { ...defaultProviderOptions(modelRef) };
  for (const [provider, opts] of Object.entries(user ?? {})) {
    merged[provider] = { ...(merged[provider] ?? {}), ...opts };
  }
  return Object.keys(merged).length ? (merged as never) : undefined;
}

export class ModelRefusalError extends Error {}

export interface RunTaskOptions<T> {
  task: AiTask;
  settings: TaskModelSettings;
  schema: z.ZodType<T>;
  /** Name/description help some providers produce better structured output. */
  name: string;
  description?: string;
  instructions: string;
  prompt: string;
  maxOutputTokens?: number;
  usage?: UsageCollector;
  abortSignal?: AbortSignal;
}

export interface RunTaskResult<T> {
  output: T;
  modelRef: string;
  usage: LanguageModelUsage;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ModelConfigError) return false;
  if (APICallError.isInstance(err)) return err.isRetryable || (err.statusCode ?? 0) >= 500;
  return true; // invalid structured output, refusals, network errors
}

/**
 * Run a structured-output task: primary model (with one retry), then the
 * configured fallback model. Throws the last error if every attempt fails.
 */
export async function runStructured<T>(opts: RunTaskOptions<T>): Promise<RunTaskResult<T>> {
  const attempts: string[] = [opts.settings.model, opts.settings.model];
  if (opts.settings.fallbackModel && opts.settings.fallbackModel !== opts.settings.model) {
    attempts.push(opts.settings.fallbackModel);
  }

  let lastError: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const modelRef = attempts[i]!;
    if (i === 1 && lastError && !isRetryable(lastError)) continue; // skip the retry, go to fallback
    try {
      const result = await generateText({
        model: await languageModel(modelRef),
        instructions: opts.instructions,
        prompt: opts.prompt,
        output: Output.object({ schema: opts.schema, name: opts.name, description: opts.description }),
        reasoning: opts.settings.reasoning,
        providerOptions: mergeProviderOptions(modelRef, opts.settings.providerOptions) as never,
        maxOutputTokens: opts.maxOutputTokens,
        maxRetries: 2,
        abortSignal: opts.abortSignal,
      });
      opts.usage?.add(opts.task, modelRef, result.usage);
      if (result.finishReason === 'content-filter') {
        throw new ModelRefusalError(`${modelRef} declined the request (content-filter)`);
      }
      return { output: result.output as T, modelRef, usage: result.usage };
    } catch (err) {
      lastError = err;
      logger.warn('AI task attempt failed', { task: opts.task, modelRef, attempt: i + 1, error: errorMessage(err) });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
}
