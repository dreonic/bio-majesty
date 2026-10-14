import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/toast';
import { Button, Card, Field, Input, SectionTitle, Select, Spinner, Switch } from '../../components/ui';
import { useResyncStock, useSettings, useUpdateSettings } from '../../lib/queries';

export function SourcesSection() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const resync = useResyncStock();
  const toast = useToast();
  const [symbol, setSymbol] = useState('');

  useEffect(() => {
    if (settings.data) setSymbol(settings.data.stock.symbol);
  }, [settings.data]);

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
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Stock symbol" hint="Yahoo Finance format, e.g. PRDA.JK">
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="w-40" />
          </Field>
          <Button
            disabled={symbol === s.stock.symbol || !symbol}
            loading={update.isPending}
            onClick={() => update.mutate({ stock: { symbol } }, { onSuccess: () => toast.success('Symbol updated — resync to load its history'), onError: toast.error })}
          >
            Save symbol
          </Button>
          <Button icon={<RefreshCw className="size-4" />} loading={resync.isPending} onClick={() => resync.mutate(undefined, { onSuccess: () => toast.success('Stock history refresh started'), onError: toast.error })}>
            Resync price history
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={s.stock.volumeAlerts}
            onChange={(v) => update.mutate({ stock: { volumeAlerts: v } }, { onError: toast.error })}
            label="Telegram alert on unusual trading volume"
          />
          <label className="flex items-center gap-2 text-sm text-ink">
            when volume reaches
            <Select
              value={String(s.stock.volumeRatio)}
              onChange={(e) => update.mutate({ stock: { volumeRatio: Number(e.target.value) } }, { onError: toast.error })}
              aria-label="Unusual volume threshold"
            >
              {[2, 2.5, 3, 4, 5].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </Select>
            the 20-day average
          </label>
        </div>
        <p className="text-xs text-muted">
          Deployment: stage <span className="font-medium text-ink-2">{s.stage}</span> · region <span className="font-medium text-ink-2">{s.region}</span>
        </p>
      </div>
    </Card>
  );
}
