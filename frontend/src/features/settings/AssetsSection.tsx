import { displaySymbol, intervalLabel, MAX_ASSETS, type StockAsset } from '@bio-majesty/shared';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Field, Input, SectionTitle, Select, Spinner, Switch } from '../../components/ui';
import { useAddAsset, useRemoveAsset, useResyncStock, useSettings, useStockAssets, useUpdateSettings } from '../../lib/queries';

/** Yahoo's instrument types in plain words. */
const TYPE_LABELS: Record<string, string> = {
  EQUITY: 'Stock',
  ETF: 'ETF',
  INDEX: 'Index',
  CURRENCY: 'Currency',
  CRYPTOCURRENCY: 'Crypto',
  FUTURE: 'Future',
  MUTUALFUND: 'Fund',
};

function describe(a: StockAsset): string {
  return [a.name, a.exchange, a.type ? (TYPE_LABELS[a.type] ?? a.type) : null, a.intradayInterval ? `${intervalLabel(a.intradayInterval)} bars` : 'daily bars only']
    .filter(Boolean)
    .join(' · ');
}

/** The account's assets (the stock panel's dropdown and the chat's price data) and their volume alerts. */
export function AssetsSection() {
  const settings = useSettings();
  const assets = useStockAssets();
  const add = useAddAsset();
  const remove = useRemoveAsset();
  const resync = useResyncStock();
  const update = useUpdateSettings();
  const toast = useToast();
  const [symbol, setSymbol] = useState('');

  if (!settings.data || !assets.data) {
    return (
      <Card className="p-5">
        <Spinner />
      </Card>
    );
  }
  const s = settings.data;
  const items = assets.data;
  const sentimentSymbol = s.profile.sentimentSymbol;
  const full = items.length >= MAX_ASSETS;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = symbol.trim().toUpperCase();
    if (!next) return;
    add.mutate(next, {
      onSuccess: () => {
        setSymbol('');
        toast.success(`${next} added — its price history is loading`);
      },
      onError: toast.error,
    });
  };

  return (
    <Card>
      <SectionTitle
        title="Assets"
        description={`Prices in the stock panel and for the chat, up to ${MAX_ASSETS}: stocks, ETFs, indices, currencies, crypto or futures. Prices come delayed from Yahoo Finance.`}
      />
      <ul className="divide-y divide-hairline">
        {items.map((a) => {
          const isSentiment = a.symbol === sentimentSymbol;
          return (
            <li key={a.symbol} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {displaySymbol(a.symbol)}
                  {a.symbol !== displaySymbol(a.symbol) && <span className="font-normal text-ink-2"> · {a.symbol}</span>}
                </p>
                <p className="truncate text-xs text-ink-2">{describe(a)}</p>
              </div>
              {isSentiment && <Badge title="News sentiment is judged against this asset (see Profile)">Sentiment</Badge>}
              <Button
                size="sm"
                variant="ghost"
                icon={<RefreshCw className="size-4" />}
                loading={resync.isPending && resync.variables === a.symbol}
                onClick={() => resync.mutate(a.symbol, { onSuccess: () => toast.success(`${a.symbol}: price history refresh started`), onError: toast.error })}
                title="Reload the full price history"
              >
                Resync
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="hover:text-critical"
                icon={<Trash2 className="size-4" />}
                disabled={isSentiment || remove.isPending}
                title={isSentiment ? 'Sentiment is judged against this asset: pick another in Profile first' : 'Remove from your assets'}
                onClick={() => remove.mutate(a.symbol, { onSuccess: () => toast.success(`${a.symbol} removed`), onError: toast.error })}
              >
                Remove
              </Button>
            </li>
          );
        })}
        {!items.length && <li className="px-5 py-4 text-sm text-ink-2">No assets yet.</li>}
      </ul>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 border-t border-hairline px-5 py-4">
        <Field label="Add an asset" hint="Yahoo Finance symbol, e.g. PRDA.JK, AAPL, ^JKSE (index), USDIDR=X (currency), BTC-USD, GC=F (gold)">
          <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="w-48" disabled={full} aria-label="Yahoo Finance symbol" />
        </Field>
        <Button type="submit" icon={<Plus className="size-4" />} disabled={!symbol.trim() || full} loading={add.isPending}>
          Add
        </Button>
        {full && <span className="pb-2 text-xs text-ink-2">Remove one to add another.</span>}
      </form>
      <div className="flex flex-wrap items-center gap-3 border-t border-hairline px-5 py-4">
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
        <p className="w-full text-xs text-muted">Currencies and most indices have no trading volume, so they never alert.</p>
      </div>
    </Card>
  );
}
