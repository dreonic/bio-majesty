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
import { startDailyRun, updateDailySchedule } from '../../lib/aws';
import { env } from '../../lib/env';
import { badRequest, json, parseBody } from '../../lib/http';
import { errorMessage } from '../../lib/logger';
import { createRouter } from '../../lib/router';
import { isTelegramConfigured } from '../../notify/telegram';
import { listRuns } from '../../repo/runs';
import { getSettings, mergeSettings, saveSettings } from '../../repo/settings';
import { getTelegramState } from '../../repo/telegram';

async function settingsView(): Promise<SettingsView> {
  const [settings, providers, telegram, telegramConfigured] = await Promise.all([
    getSettings(),
    configuredProviders(),
    getTelegramState(),
    isTelegramConfigured(),
  ]);
  return {
    ...settings,
    embedding: { model: env.embeddingModel || DEFAULT_EMBEDDING.model, dimensions: env.embeddingDimensions },
    telegram: {
      configured: telegramConfigured,
      linked: telegram.chatId !== null,
      chatTitle: telegram.chatTitle,
      linkedAt: telegram.linkedAt,
    },
    configuredProviders: providers,
    stage: env.stage,
    region: env.region,
  };
}

export const handler = createRouter({
  'GET /settings': async () => json(200, await settingsView()),

  'PUT /settings': async (event) => {
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
    const current = await getSettings();
    const next = mergeSettings(current, update);
    const scheduleChanged =
      next.schedule.dailyTime !== current.schedule.dailyTime || next.schedule.enabled !== current.schedule.enabled;
    if (scheduleChanged) await updateDailySchedule(next.schedule.dailyTime, next.schedule.enabled);
    await saveSettings(next);
    return json(200, await settingsView());
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

  'GET /runs': async () => json(200, { items: await listRuns(25) }),

  'POST /runs/daily': async () => {
    const executionArn = await startDailyRun('manual');
    return json(202, { executionArn });
  },
});
