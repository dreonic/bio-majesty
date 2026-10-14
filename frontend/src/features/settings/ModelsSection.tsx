import {
  AI_TASK_LABELS,
  AI_TASKS,
  PROVIDER_LABELS,
  PROVIDER_SECRET_KEYS,
  PROVIDERS,
  REASONING_LEVELS,
  type AiTask,
  type ReasoningLevel,
  type TaskModelSettings,
} from '@bio-majesty/shared';
import { CheckCircle2, CircleAlert, FlaskConical } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Input, SectionTitle, Select, Spinner, Textarea } from '../../components/ui';
import { useModels, useSettings, useTestModel, useUpdateSettings } from '../../lib/queries';

type ModelsState = Record<AiTask, TaskModelSettings>;
const CUSTOM = '__custom__';

export function ModelsSection() {
  const settings = useSettings();
  const models = useModels();
  const update = useUpdateSettings();
  const toast = useToast();
  const [state, setState] = useState<ModelsState | null>(null);

  useEffect(() => {
    if (settings.data && !state) setState(settings.data.models);
  }, [settings.data, state]);

  const configured = new Set(models.data?.configuredProviders ?? settings.data?.configuredProviders ?? []);
  const dirty = state && settings.data && JSON.stringify(state) !== JSON.stringify(settings.data.models);

  const save = () => {
    if (!state) return;
    update.mutate({ models: state }, { onSuccess: () => toast.success('Model settings saved'), onError: toast.error });
  };

  return (
    <Card>
      <SectionTitle
        title="AI models"
        description="Choose the model for each task. Any provider with an API key in the stack's secret can be used; changes apply to the next run."
        actions={
          <Button variant="primary" onClick={save} disabled={!dirty} loading={update.isPending}>
            Save models
          </Button>
        }
      />
      <div className="flex flex-wrap gap-2 border-b border-hairline px-5 py-3 text-xs">
        {PROVIDERS.map((p) => (
          <Badge key={p} title={configured.has(p) ? 'API key configured' : `Add ${PROVIDER_SECRET_KEYS[p]} to the secret to enable`}>
            {configured.has(p) ? <CheckCircle2 className="size-3.5 text-good" aria-hidden /> : <CircleAlert className="size-3.5 text-muted" aria-hidden />}
            {PROVIDER_LABELS[p]} {configured.has(p) ? '' : '(no key)'}
          </Badge>
        ))}
      </div>
      {!state || models.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="divide-y divide-hairline">
          {AI_TASKS.map((task) => (
            <TaskRow
              key={task}
              task={task}
              value={state[task]}
              onChange={(v) => setState({ ...state, [task]: v })}
              models={models.data?.models ?? []}
              configured={configured}
            />
          ))}
          <div className="px-5 py-4 text-sm text-ink-2">
            <span className="font-medium text-ink">Embeddings:</span> {settings.data?.embedding.model} ({settings.data?.embedding.dimensions} dims). Set at deploy time
            (cdk.json <code>embeddingModel</code>); changing it creates a new vector index and saved articles must be re-indexed.
          </div>
        </div>
      )}
    </Card>
  );
}

function TaskRow({
  task,
  value,
  onChange,
  models,
  configured,
}: {
  task: AiTask;
  value: TaskModelSettings;
  onChange: (v: TaskModelSettings) => void;
  models: { id: string; label: string; provider: string; price?: string; available: boolean }[];
  configured: Set<string>;
}) {
  const test = useTestModel();
  const known = useMemo(() => new Set(models.map((m) => m.id)), [models]);
  const [customPrimary, setCustomPrimary] = useState(!known.has(value.model));
  const [showAdvanced, setShowAdvanced] = useState(Boolean(value.providerOptions));
  const [optionsText, setOptionsText] = useState(value.providerOptions ? JSON.stringify(value.providerOptions, null, 2) : '');
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const meta = AI_TASK_LABELS[task];

  const modelOptions = (selected: string) => (
    <>
      {PROVIDERS.map((p) => {
        const list = models.filter((m) => m.provider === p);
        if (!list.length) return null;
        return (
          <optgroup key={p} label={`${PROVIDER_LABELS[p]}${configured.has(p) ? '' : ' (no API key)'}`}>
            {list.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.available && m.id !== selected}>
                {m.label}
                {m.price ? ` — ${m.price}/MTok` : ''}
              </option>
            ))}
          </optgroup>
        );
      })}
      <option value={CUSTOM}>Custom model id…</option>
    </>
  );

  return (
    <div className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div>
        <p className="font-medium text-ink">{meta.label}</p>
        <p className="mt-0.5 text-sm text-ink-2">{meta.description}</p>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {customPrimary ? (
            <Input
              value={value.model}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
              placeholder="provider:model-id, e.g. openrouter:deepseek/deepseek-chat"
              className="min-w-64 flex-1"
              aria-label={`${meta.label} model`}
            />
          ) : (
            <Select
              value={value.model}
              onChange={(e) => (e.target.value === CUSTOM ? setCustomPrimary(true) : onChange({ ...value, model: e.target.value }))}
              className="min-w-64 flex-1"
              aria-label={`${meta.label} model`}
            >
              {modelOptions(value.model)}
            </Select>
          )}
          <Select value={value.reasoning} onChange={(e) => onChange({ ...value, reasoning: e.target.value as ReasoningLevel })} aria-label="Reasoning effort" title="Reasoning effort">
            {REASONING_LEVELS.map((r) => (
              <option key={r} value={r}>
                {r === 'provider-default' ? 'Default effort' : `Effort: ${r}`}
              </option>
            ))}
          </Select>
          <Button size="sm" icon={<FlaskConical className="size-4" />} loading={test.isPending} onClick={() => test.mutate(value.model)}>
            Test
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-2">Fallback</span>
          <Select
            value={value.fallbackModel ?? ''}
            onChange={(e) => onChange({ ...value, fallbackModel: e.target.value || null })}
            className="h-8 min-w-56 text-xs"
            aria-label={`${meta.label} fallback model`}
          >
            <option value="">None</option>
            {models
              .filter((m) => m.id !== value.model)
              .map((m) => (
                <option key={m.id} value={m.id} disabled={!m.available}>
                  {m.label}
                </option>
              ))}
          </Select>
          <button className="text-xs text-accent-strong hover:underline" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? 'Hide' : 'Advanced'} provider options
          </button>
          {customPrimary && (
            <button className="text-xs text-accent-strong hover:underline" onClick={() => setCustomPrimary(false)}>
              Pick from list
            </button>
          )}
        </div>
        {test.data && (
          <p className={test.data.ok ? 'text-xs text-good-text' : 'text-xs text-critical'}>
            {test.data.ok ? `OK in ${(test.data.latencyMs / 1000).toFixed(1)} s — replied “${test.data.output}”` : `Failed: ${test.data.error}`}
          </p>
        )}
        {showAdvanced && (
          <div className="space-y-1">
            <Textarea
              rows={3}
              value={optionsText}
              onChange={(e) => {
                setOptionsText(e.target.value);
                if (!e.target.value.trim()) {
                  setOptionsError(null);
                  onChange({ ...value, providerOptions: null });
                  return;
                }
                try {
                  const parsed = JSON.parse(e.target.value) as Record<string, Record<string, unknown>>;
                  setOptionsError(null);
                  onChange({ ...value, providerOptions: parsed });
                } catch {
                  setOptionsError('Not valid JSON yet');
                }
              }}
              placeholder='{"anthropic": {"effort": "low"}}'
              className="font-mono text-xs"
              aria-label="Provider options JSON"
            />
            {optionsError && <p className="text-xs text-critical">{optionsError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
