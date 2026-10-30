import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  AI_TASKS,
  DEFAULT_SETTINGS,
  quarterHour,
  SettingsSchema,
  type Settings,
  type SettingsUpdate,
} from '@bio-majesty/shared';
import { logger } from '../lib/logger';
import { ddb, table } from './client';
import { keys, type ProfileId } from './keys';

/** The profile's settings, filling any missing sections with defaults (a new profile has none stored). */
export async function getSettings(profileId: ProfileId): Promise<Settings> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.settings(profileId) }));
  const stored = (res.Item?.data ?? {}) as Partial<Settings>;
  return mergeSettings(DEFAULT_SETTINGS, stored);
}

export function mergeSettings(base: Settings, patch: Partial<Settings> | SettingsUpdate): Settings {
  const models = { ...base.models };
  for (const task of AI_TASKS) {
    const p = patch.models?.[task];
    if (p) models[task] = { ...base.models[task], ...p };
  }
  const schedule = { ...base.schedule, ...(patch.schedule ?? {}) };
  const merged = {
    models,
    // Older values may not sit on a quarter hour (run times are quarter hours).
    schedule: { ...schedule, dailyTime: quarterHour(schedule.dailyTime) },
    sources: { ...base.sources, ...(patch.sources ?? {}) },
    notifications: { ...base.notifications, ...(patch.notifications ?? {}) },
    stock: { ...base.stock, ...(patch.stock ?? {}) },
    subject: { ...base.subject, ...(patch.subject ?? {}) },
    learning: { ...base.learning, ...(patch.learning ?? {}) },
    updatedAt: 'updatedAt' in patch && patch.updatedAt ? patch.updatedAt : base.updatedAt,
  };
  const parsed = SettingsSchema.safeParse(merged);
  if (!parsed.success) {
    logger.warn('Stored settings invalid; falling back to defaults for bad fields', { issues: parsed.error.issues });
    return base;
  }
  return parsed.data;
}

export async function saveSettings(profileId: ProfileId, settings: Settings): Promise<Settings> {
  const next = { ...settings, updatedAt: new Date().toISOString() };
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.settings(profileId), data: next } }));
  return next;
}
