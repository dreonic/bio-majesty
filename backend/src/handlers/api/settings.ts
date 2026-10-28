import {
  AI_TASKS,
  DEFAULT_EMBEDDING,
  LANGUAGE_MODELS,
  parseModelRef,
  SettingsUpdateSchema,
  TestModelRequestSchema,
  type ProviderId,
  type SettingsView,
  type TestModelResponse,
} from '@bio-majesty/shared';
import { generateText } from 'ai';
import { configuredProviders, languageModel } from '../../ai/registry';
import { mergeProviderOptions } from '../../ai/run-task';
import { startDailyRun } from '../../lib/aws';
import { env } from '../../lib/env';
import { badRequest, json, parseBody } from '../../lib/http';
import { errorMessage } from '../../lib/logger';
import { createRouter } from '../../lib/router';
import { isTelegramConfigured } from '../../notify/telegram';
import { listRuns } from '../../repo/runs';
import { getSettings, mergeSettings, saveSettings } from '../../repo/settings';
import { listTelegramLinks } from '../../repo/telegram';

async function settingsView(sub: string): Promise<SettingsView> {
  const [settings, providers, telegram, telegramConfigured] = await Promise.all([
    getSettings(sub),
    configuredProviders(),
    listTelegramLinks(sub),
    isTelegramConfigured(),
  ]);
  return {
    ...settings,
    embedding: { model: env.embeddingModel || DEFAULT_EMBEDDING.model, dimensions: env.embeddingDimensions },
    telegram: {
      configured: telegramConfigured,
      connections: telegram.map(({ id, chatTitle, kind, linkedAt }) => ({ id, chatTitle, kind, linkedAt })),
    },
    configuredProviders: providers,
    stage: env.stage,
    region: env.region,
  };
}

export const handler = createRouter({
  'GET /settings': async (_event, user) => json(200, await settingsView(user.sub)),

  'PUT /settings': async (event, user) => {
    const update = parseBody(event, SettingsUpdateSchema);
    const providers = await configuredProviders();
    for (const task of AI_TASKS) {
      const m = update.models?.[task];
      if (!m) continue;
      for (const ref of [m.model, m.fallbackModel].filter((r): r is string => Boolean(r))) {
        const provider = parseModelRef(ref)?.provider as ProviderId | undefined;
        if (!provider || !providers.includes(provider)) {
          throw badRequest(`No API key configured for the provider of "${ref}"`);
        }
      }
    }
    const current = await getSettings(user.sub);
    const next = mergeSettings(current, update);
    const sentiment = next.profile.sentimentAsset;
    if (sentiment && !next.stock.assets.includes(sentiment)) {
      throw badRequest(`Sentiment can only be judged against one of your assets; add ${sentiment} in Settings → Assets first`);
    }
    // The dispatcher reads the schedule from here every 15 minutes: nothing else to update.
    await saveSettings(user.sub, next);
    return json(200, await settingsView(user.sub));
  },

  'GET /settings/models': async () => {
    const providers = await configuredProviders();
    return json(200, {
      configuredProviders: providers,
      models: LANGUAGE_MODELS.map((m) => ({ ...m, available: providers.includes(m.provider) })),
    });
  },

  'POST /settings/test-model': async (event) => {
    const { model } = parseBody(event, TestModelRequestSchema);
    const started = Date.now();
    let result: TestModelResponse;
    try {
      const res = await generateText({
        model: await languageModel(model),
        prompt: 'Reply with the single word: OK',
        providerOptions: mergeProviderOptions(model, null) as never,
        maxOutputTokens: 2000,
        maxRetries: 1,
      });
      result = { ok: true, latencyMs: Date.now() - started, output: res.text.trim().slice(0, 200), error: null };
    } catch (err) {
      result = { ok: false, latencyMs: Date.now() - started, output: null, error: errorMessage(err).slice(0, 500) };
    }
    return json(200, result);
  },

  'GET /runs': async (_event, user) => json(200, { items: await listRuns(user.sub, 25) }),

  'POST /runs/daily': async (_event, user) => {
    const executionArn = await startDailyRun(user.sub, 'manual');
    return json(202, { executionArn });
  },
});
