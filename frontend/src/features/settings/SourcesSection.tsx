import { useToast } from '../../components/toast';
import { Card, SectionTitle, Spinner, Switch } from '../../components/ui';
import { useSettings, useUpdateSettings } from '../../lib/queries';

export function SourcesSection() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const toast = useToast();

  if (!settings.data) {
    return (
      <Card className="p-5">
        <Spinner />
      </Card>
    );
  }
  const s = settings.data;
  return (
    <Card>
      <SectionTitle title="Data sources" description="Free sources are used by default; see docs/alternatives.md for paid options." />
      <div className="space-y-5 px-5 py-4">
        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">News search</p>
          <div className="flex flex-wrap gap-6">
            <Switch
              checked={s.sources.googleNews}
              onChange={(v) => update.mutate({ sources: { googleNews: v } }, { onError: toast.error })}
              label="Google News (RSS)"
            />
            <Switch checked={s.sources.gdelt} onChange={(v) => update.mutate({ sources: { gdelt: v } }, { onError: toast.error })} label="GDELT (last ~3 months)" />
          </div>
        </div>
        <p className="text-xs text-muted">
          Deployment: stage <span className="font-medium text-ink-2">{s.stage}</span> · region <span className="font-medium text-ink-2">{s.region}</span>
        </p>
      </div>
    </Card>
  );
}
