import { z } from 'zod';
import { IsoDateTime } from './common';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL, parseModelRef } from './models';
import { AssetIdSchema } from './stock';
import { TelegramConnectionSchema } from './telegram';

/** LLM tasks whose model can be chosen in Settings. */
export const AI_TASKS = ['querySuggest', 'prefilter', 'tagging', 'digest', 'chat'] as const;
export const AiTaskSchema = z.enum(AI_TASKS);
export type AiTask = z.infer<typeof AiTaskSchema>;

export const AI_TASK_LABELS: Record<AiTask, { label: string; description: string }> = {
  querySuggest: {
    label: 'Query suggestions',
    description: 'Suggests search queries, each with its Google News edition, when you create a category.',
  },
  prefilter: {
    label: 'Headline prefilter',
    description: 'Drops obviously irrelevant search results before articles are fetched.',
  },
  tagging: {
    label: 'Tagging',
    description: 'Reads each article and suggests categories, sentiment, rationale and a summary.',
  },
  digest: {
    label: 'Digest',
    description: 'Writes the short daily brief shown in the dashboard and sent to Telegram.',
  },
  chat: {
    label: 'Chat',
    description: 'Answers questions over saved news (uses tools to search articles and prices).',
  },
};

/**
 * Portable reasoning effort (AI SDK `reasoning` option). 'none' is deliberately
 * omitted: some models (e.g. Claude Opus 5.5) cannot disable thinking.
 */
export const REASONING_LEVELS = ['provider-default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ReasoningLevelSchema = z.enum(REASONING_LEVELS);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

const ModelRefSchema = z
  .string()
  .trim()
  .max(200)
  .refine((v) => parseModelRef(v) !== null, 'expected "provider:modelId"');

export const TaskModelSettingsSchema = z.object({
  model: ModelRefSchema,
  fallbackModel: ModelRefSchema.nullable().default(null),
  reasoning: ReasoningLevelSchema.default('provider-default'),
  /** Advanced: provider-specific options, e.g. {"anthropic": {"effort": "low"}}. */
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().default(null),
});
export type TaskModelSettings = z.infer<typeof TaskModelSettingsSchema>;

/** HH:mm on a quarter hour; each profile's run starts a fixed few minutes later (dailyRunOffset). */
export const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export const ScheduleSettingsSchema = z.object({
  enabled: z.boolean(),
  /** HH:mm in the deployment's `timeZone` (default Asia/Singapore), in 15-minute steps. */
  dailyTime: z.string().regex(DAILY_TIME_PATTERN, 'expected HH:mm on a quarter hour'),
});

/** Round any HH:mm down to its quarter hour ("06:10" -> "06:00"); other strings are returned as they are. */
export function quarterHour(hhmm: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return hhmm;
  return `${m[1]}:${String(Math.floor(Number(m[2]) / 15) * 15).padStart(2, '0')}`;
}

/** Most assets one profile can track (each adds requests to its market-data source). */
export const MAX_ASSETS = 10;

/**
 * Who or what a profile's news is about (Settings → Subject). It sets the context of every AI
 * task and what sentiment means: the price of one of the profile's assets, or (no asset) good
 * or bad news for the subject itself.
 */
export const SubjectSchema = z.object({
  /** How the AI refers to the subject, e.g. "Acme Group" or "the Singapore property market"; empty = the topics of the profile's categories. */
  name: z.string().trim().max(120),
  /** Entities and their aliases, unrelated look-alikes, typical sources, what counts as good or bad news. */
  context: z.string().trim().max(6000),
  /** Sentiment is judged against this asset's price (its ID); null = the subject itself. */
  sentimentAsset: AssetIdSchema.nullable(),
});
export type Subject = z.infer<typeof SubjectSchema>;

/** Starting subject of every profile: blank until the profile describes what it follows. */
export const DEFAULT_SUBJECT: Subject = { name: '', context: '', sentimentAsset: null };

export const SettingsSchema = z.object({
  models: z.object({
    querySuggest: TaskModelSettingsSchema,
    prefilter: TaskModelSettingsSchema,
    tagging: TaskModelSettingsSchema,
    digest: TaskModelSettingsSchema,
    chat: TaskModelSettingsSchema,
  }),
  schedule: ScheduleSettingsSchema,
  sources: z.object({
    googleNews: z.boolean(),
    gdelt: z.boolean(),
  }),
  notifications: z.object({
    /** Send a Telegram message even when a run finds nothing new. */
    notifyWhenEmpty: z.boolean(),
  }),
  stock: z.object({
    /** Asset IDs ("yahoo:D05.SI"), in the order the stock panel lists them (added and removed via /stock/assets). */
    assets: z.array(AssetIdSchema).max(MAX_ASSETS),
    /** Telegram alert when volume is far above its 20-day average. */
    volumeAlerts: z.boolean(),
    /** Volume / 20-day average ratio that counts as unusual. */
    volumeRatio: z.number().min(1.5).max(20),
  }),
  subject: SubjectSchema,
  learning: z.object({
    /**
     * Give the tagging model the profile's recent corrections as examples.
     * Corrections are always stored for future training, even when off.
     */
    useFeedbackContext: z.boolean(),
    maxExamples: z.number().int().min(1).max(30),
  }),
  updatedAt: IsoDateTime.nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Read-only facts about the deployment that the UI displays alongside settings. */
export const SettingsViewSchema = SettingsSchema.extend({
  embedding: z.object({ model: z.string(), dimensions: z.number() }),
  telegram: z.object({
    configured: z.boolean(),
    /** Every chat and topic the profile's notifications go to. */
    connections: z.array(TelegramConnectionSchema),
  }),
  configuredProviders: z.array(z.string()),
  stage: z.string(),
  region: z.string(),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

export const SettingsUpdateSchema = z.object({
  models: z
    .object({
      querySuggest: TaskModelSettingsSchema,
      prefilter: TaskModelSettingsSchema,
      tagging: TaskModelSettingsSchema,
      digest: TaskModelSettingsSchema,
      chat: TaskModelSettingsSchema,
    })
    .partial()
    .optional(),
  schedule: ScheduleSettingsSchema.partial().optional(),
  sources: z.object({ googleNews: z.boolean(), gdelt: z.boolean() }).partial().optional(),
  notifications: z.object({ notifyWhenEmpty: z.boolean() }).partial().optional(),
  stock: z.object({ volumeAlerts: z.boolean(), volumeRatio: z.number().min(1.5).max(20) }).partial().optional(),
  subject: SubjectSchema.partial().optional(),
  learning: z.object({ useFeedbackContext: z.boolean(), maxExamples: z.number().int().min(1).max(30) }).partial().optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

const DEFAULT_MODEL = 'anthropic:claude-haiku-5-5';

export const DEFAULT_SETTINGS: Settings = {
  models: {
    querySuggest: { model: DEFAULT_MODEL, fallbackModel: null, reasoning: 'medium', providerOptions: null },
    prefilter: { model: DEFAULT_MODEL, fallbackModel: null, reasoning: 'low', providerOptions: null },
    tagging: { model: DEFAULT_MODEL, fallbackModel: null, reasoning: 'low', providerOptions: null },
    digest: { model: DEFAULT_MODEL, fallbackModel: null, reasoning: 'low', providerOptions: null },
    chat: { model: DEFAULT_MODEL, fallbackModel: null, reasoning: 'medium', providerOptions: null },
  },
  schedule: { enabled: true, dailyTime: '06:00' },
  sources: { googleNews: true, gdelt: true },
  notifications: { notifyWhenEmpty: false },
  stock: { assets: [], volumeAlerts: true, volumeRatio: 2.5 },
  subject: DEFAULT_SUBJECT,
  learning: { useFeedbackContext: false, maxExamples: 8 },
  updatedAt: null,
};

export const DEFAULT_EMBEDDING = {
  model: DEFAULT_EMBEDDING_MODEL,
  dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
};

export const TestModelRequestSchema = z.object({ model: ModelRefSchema });
export const TestModelResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});
export type TestModelResponse = z.infer<typeof TestModelResponseSchema>;
