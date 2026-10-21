import { quarterHour, type Run } from '@bio-majesty/shared';
import { CheckCircle2, CircleAlert, Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/toast';
import { Button, Card, Input, SectionTitle, Spinner, Switch } from '../../components/ui';
import { displayTimeZone, formatDateTime, timeZoneLabel } from '../../lib/format';
import { useCategories, useFeedbackStats, useRunDaily, useRuns, useSettings, useUpdateSettings } from '../../lib/queries';

export function ScheduleSection() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const runDaily = useRunDaily();
  const runs = useRuns();
  const feedback = useFeedbackStats();
  const categories = useCategories().data ?? [];
  const toast = useToast();
  const [time, setTime] = useState('06:00');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (settings.data) {
      setTime(settings.data.schedule.dailyTime);
      setEnabled(settings.data.schedule.enabled);
    }
  }, [settings.data]);

  const dirty = settings.data && (quarterHour(time) !== settings.data.schedule.dailyTime || enabled !== settings.data.schedule.enabled);
  const names = new Map(categories.map((c) => [c.id, c.name]));

  return (
    <Card>
      <SectionTitle
        title="Daily run"
        description="Searches the last 24 hours (or since the last successful run) for every active category, then tags and summarises what it finds."
        actions={
          <Button
            icon={<Play className="size-4" />}
            loading={runDaily.isPending}
            onClick={() => runDaily.mutate(undefined, { onSuccess: () => toast.success('Daily run started'), onError: toast.error })}
          >
            Run now
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-4 border-b border-hairline px-5 py-4">
        <label className="flex items-center gap-2 text-sm text-ink">
          Run every day at
          {/* The dispatcher checks every 15 minutes, so run times are quarter hours. */}
          <Input type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} className="w-32" aria-label="Daily run time (quarter hours)" />
          <span className="text-ink-2" title={displayTimeZone()}>
            {timeZoneLabel()}
          </span>
        </label>
        <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty}
          loading={update.isPending}
          onClick={() =>
            update.mutate(
              { schedule: { dailyTime: quarterHour(time), enabled } },
              { onSuccess: (s) => toast.success(`Schedule updated: every day at ${s.schedule.dailyTime}`), onError: toast.error },
            )
          }
        >
          Save schedule
        </Button>
      </div>
      <div className="space-y-1.5 border-b border-hairline px-5 py-4">
        <Switch
          checked={settings.data?.learning.useFeedbackContext ?? false}
          disabled={!settings.data || update.isPending}
          onChange={(v) =>
            update.mutate(
              { learning: { useFeedbackContext: v } },
              { onSuccess: () => toast.success(v ? 'Runs will use your past corrections' : 'Runs will ignore your past corrections'), onError: toast.error },
            )
          }
          label="Use my past corrections as context when tagging"
        />
        <p className="text-xs text-ink-2">
          Every save, skip and edit you make is stored as training data for the classifier
          {feedback.data ? ` (${feedback.data.total} decision${feedback.data.total === 1 ? '' : 's'} so far, ${feedback.data.corrections} with corrections)` : ''}.
          When this is on, runs show the AI your {settings.data?.learning.maxExamples ?? 8} most recent corrections as examples; when off they are only stored.
        </p>
      </div>
      <div className="overflow-x-auto px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-2 uppercase">Recent runs</h3>
        {runs.isLoading ? (
          <Spinner />
        ) : !runs.data?.length ? (
          <p className="text-sm text-ink-2">No runs yet.</p>
        ) : (
          <table className="tabular w-full text-sm">
            <thead className="text-left text-xs text-ink-2">
              <tr className="border-b border-grid">
                <th className="py-1.5 pr-3 font-medium">Started</th>
                <th className="py-1.5 pr-3 font-medium">Type</th>
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 pr-3 text-right font-medium">Found</th>
                <th className="py-1.5 pr-3 text-right font-medium">Duplicates</th>
                <th className="py-1.5 pr-3 text-right font-medium">Filtered</th>
                <th className="py-1.5 pr-3 text-right font-medium">To review</th>
                <th className="py-1.5 text-right font-medium">Tokens (in/out)</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <RunRow key={r.id} run={r} categoryName={r.categoryId ? names.get(r.categoryId) : undefined} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

function RunRow({ run, categoryName }: { run: Run; categoryName?: string }) {
  const tokensIn = run.usage.reduce((s, u) => s + u.inputTokens, 0);
  const tokensOut = run.usage.reduce((s, u) => s + u.outputTokens, 0);
  const models = [...new Set(run.usage.map((u) => u.model))].join(', ');
  return (
    <tr className="border-b border-grid/60 align-top text-ink">
      <td className="py-1.5 pr-3 whitespace-nowrap">{formatDateTime(run.startedAt)}</td>
      <td className="py-1.5 pr-3">{run.type === 'backfill' ? `Backfill${categoryName ? ` · ${categoryName}` : ''}` : 'Daily'}</td>
      <td className="py-1.5 pr-3">
        <span className="inline-flex items-center gap-1" title={run.error ?? undefined}>
          {run.status === 'running' ? (
            <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden />
          ) : run.status === 'succeeded' ? (
            <CheckCircle2 className="size-3.5 text-good" aria-hidden />
          ) : (
            <CircleAlert className="size-3.5 text-critical" aria-hidden />
          )}
          {run.status === 'running' ? 'Running' : run.status === 'succeeded' ? 'Succeeded' : 'Failed'}
        </span>
        {run.error && <p className="max-w-xs truncate text-xs text-critical">{run.error}</p>}
      </td>
      <td className="py-1.5 pr-3 text-right">{run.stats.found}</td>
      <td className="py-1.5 pr-3 text-right">{run.stats.duplicates}</td>
      <td className="py-1.5 pr-3 text-right">{run.stats.filtered}</td>
      <td className="py-1.5 pr-3 text-right">{run.stats.pending}</td>
      <td className="py-1.5 text-right" title={models}>
        {tokensIn || tokensOut ? `${Math.round(tokensIn / 1000)}k / ${Math.round(tokensOut / 1000)}k` : '—'}
      </td>
    </tr>
  );
}
