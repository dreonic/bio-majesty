/**
 * Switch every account's saved AI model choices to Claude Haiku 5.5 (the new default), used by
 * scripts/migrate-models-haiku.ts. Pure: no AWS calls.
 */
export const HAIKU = 'anthropic:claude-haiku-5-5';

export type Item = Record<string, unknown>;

type TaskModels = Record<string, Record<string, unknown>>;

export interface ModelsUpdate {
  key: { PK: string; SK: string };
  /** The account's `data.models`, every task on Haiku (a fallback that would be Haiku too is dropped). */
  models: TaskModels;
}

/** Settings items whose saved models aren't all Haiku yet. Accounts without saved models use the defaults. */
export function planHaikuModels(items: Item[]): ModelsUpdate[] {
  return items.flatMap((i) => {
    if (!String(i.PK).startsWith('USER#') || i.SK !== 'SETTINGS') return [];
    const saved = ((i.data as Record<string, unknown> | undefined)?.models ?? {}) as TaskModels;
    const models: TaskModels = {};
    for (const [task, settings] of Object.entries(saved)) {
      models[task] = { ...settings, model: HAIKU, ...(settings.fallbackModel === HAIKU ? { fallbackModel: null } : {}) };
    }
    const changed = Object.entries(saved).some(([task, s]) => JSON.stringify(s) !== JSON.stringify(models[task]));
    return changed ? [{ key: { PK: String(i.PK), SK: String(i.SK) }, models }] : [];
  });
}
