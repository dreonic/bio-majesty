import {
  displaySymbol,
  intervalLabel,
  MAX_ASSETS,
  normalizeSymbol,
  STOCK_SOURCE_INFO,
  symbolProblem,
  type StockAsset,
  type StockSource,
  type SymbolMatch,
} from '@bio-majesty/shared';
import { AlertTriangle, Check, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, Input, SectionTitle, Select, Spinner, Switch } from '../../components/ui';
import { useDebounced } from '../../lib/hooks';
import { useAddAsset, useRemoveAsset, useResyncStock, useSettings, useStockAssets, useStockSources, useSymbolSearch, useUpdateSettings } from '../../lib/queries';

/** Instrument types (Yahoo's names, used for every source) in plain words. */
const TYPE_LABELS: Record<string, string> = {
  EQUITY: 'Stock',
  ETF: 'ETF',
  INDEX: 'Index',
  CURRENCY: 'Currency',
  CRYPTOCURRENCY: 'Crypto',
  FUTURE: 'Future',
  MUTUALFUND: 'Fund',
};
/** Matches shown under the symbol box. */
const SHOWN_MATCHES = 6;

const typeLabel = (type: string | null) => (type ? (TYPE_LABELS[type] ?? type) : null);

function bars(a: StockAsset): string {
  if (!a.intradayInterval) return 'daily bars only';
  const label = `${intervalLabel(a.intradayInterval)} bars`;
  return STOCK_SOURCE_INFO[a.source].intraday === 'after-close' ? `${label} after the close` : label;
}

function describe(a: StockAsset): string {
  return [a.name, a.exchange, typeLabel(a.type), bars(a)].filter(Boolean).join(' · ');
}

function describeMatch(m: SymbolMatch): string {
  return [m.name, m.exchange, typeLabel(m.type)].filter(Boolean).join(' · ');
}

/** The account's assets (the stock panel's dropdown and the chat's price data) and their volume alerts. */
export function AssetsSection() {
  const settings = useSettings();
  const assets = useStockAssets();
  const sources = useStockSources();
  const update = useUpdateSettings();
  const toast = useToast();

  if (!settings.data || !assets.data || !sources.data) {
    return (
      <Card className="p-5">
        <Spinner />
      </Card>
    );
  }
  const s = settings.data;
  const items = assets.data;
  // Sources only need naming once there is more than one to tell apart.
  const manySources = sources.data.length > 1 || new Set(items.map((a) => a.source)).size > 1;
  const origin = manySources ? 'Each comes from the source it was added from.' : `They come from ${STOCK_SOURCE_INFO[sources.data[0] ?? 'yahoo'].label}.`;

  return (
    <Card>
      <SectionTitle
        title="Assets"
        description={`Prices in the stock panel and for the chat, up to ${MAX_ASSETS}: stocks, ETFs, indices, currencies, crypto or futures. Prices are delayed. ${origin}`}
      />
      <AssetList items={items} sentimentAsset={s.profile.sentimentAsset} showSource={manySources} />
      <AddAsset sources={sources.data} full={items.length >= MAX_ASSETS} />
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

function AssetList({ items, sentimentAsset, showSource }: { items: StockAsset[]; sentimentAsset: string | null; showSource: boolean }) {
  const remove = useRemoveAsset();
  const resync = useResyncStock();
  const toast = useToast();
  return (
    <ul className="divide-y divide-hairline">
      {items.map((a) => {
        const isSentiment = a.id === sentimentAsset;
        const ticker = displaySymbol(a.id);
        return (
          <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">
                {ticker}
                {a.symbol !== ticker && <span className="font-normal text-ink-2"> · {a.symbol}</span>}
              </p>
              <p className="truncate text-xs text-ink-2">{describe(a)}</p>
            </div>
            {showSource && <Badge title="Where this asset's prices come from">{STOCK_SOURCE_INFO[a.source].label}</Badge>}
            {isSentiment && <Badge title="News sentiment is judged against this asset (see Profile)">Sentiment</Badge>}
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw className="size-4" />}
              loading={resync.isPending && resync.variables === a.id}
              onClick={() => resync.mutate(a.id, { onSuccess: () => toast.success(`${a.symbol}: price history refresh started`), onError: toast.error })}
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
              onClick={() => remove.mutate(a.id, { onSuccess: () => toast.success(`${a.symbol} removed`), onError: toast.error })}
            >
              Remove
            </Button>
          </li>
        );
      })}
      {!items.length && <li className="px-5 py-4 text-sm text-ink-2">No assets yet.</li>}
    </ul>
  );
}

/**
 * Add an asset: type a name to search the source, or its symbol. A match is confirmed under the
 * box before adding; the API looks the symbol up again and suggests matches when it has no data.
 */
function AddAsset({ sources, full }: { sources: StockSource[]; full: boolean }) {
  const add = useAddAsset();
  const toast = useToast();
  const [source, setSource] = useState<StockSource>(sources[0] ?? 'yahoo');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<SymbolMatch | null>(null);
  const query = useDebounced(text.trim(), 350);
  const search = useSymbolSearch(source, picked ? '' : query);
  const info = STOCK_SOURCE_INFO[source];

  const symbol = normalizeSymbol(picked?.symbol ?? text);
  const problem = symbol ? symbolProblem(source, symbol) : null;
  // (Right after a source change, the previous source's results are still the placeholder.)
  const matches = query.length >= 2 && !picked ? (search.data?.items ?? []).filter((m) => m.source === source) : [];
  // A typed symbol the source also found: confirm it like a picked one.
  const confirmed = picked ?? matches.find((m) => m.symbol === symbol) ?? null;

  const choose = (m: SymbolMatch) => {
    setPicked(m);
    setText(m.symbol);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!symbol || problem) return;
    add.mutate(
      { source, symbol },
      {
        onSuccess: () => {
          setText('');
          setPicked(null);
          toast.success(`${symbol} added — its price history is loading`);
        },
        onError: toast.error,
      },
    );
  };

  return (
    // Laid out like Field, with the button on the input's row (the hint goes below both).
    <form onSubmit={submit} className="space-y-1.5 border-t border-hairline px-5 py-4">
      <label htmlFor="add-asset-symbol" className="block text-sm font-medium text-ink">
        Add an asset
      </label>
      <div className="flex flex-wrap items-center gap-3">
        {sources.length > 1 && (
          <Select
            value={source}
            onChange={(e) => {
              setSource(e.target.value as StockSource);
              setPicked(null);
            }}
            aria-label="Price source"
            disabled={full}
          >
            {sources.map((s) => (
              <option key={s} value={s}>
                {STOCK_SOURCE_INFO[s].label}
              </option>
            ))}
          </Select>
        )}
        <Input
          id="add-asset-symbol"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPicked(null);
          }}
          placeholder="Name or symbol"
          autoComplete="off"
          className="w-56"
          disabled={full}
        />
        <Button type="submit" icon={<Plus className="size-4" />} disabled={!symbol || Boolean(problem) || full} loading={add.isPending} title={problem ?? undefined}>
          Add
        </Button>
        {search.isFetching && <Spinner className="size-4" />}
        {full && <span className="text-xs text-ink-2">Remove one to add another.</span>}
      </div>
      {confirmed ? (
        <p className="flex items-center gap-1.5 text-xs text-ink">
          <Check className="size-3.5 text-good-text" aria-hidden />
          <span className="font-medium">{confirmed.symbol}</span>
          <span className="truncate text-ink-2">{describeMatch(confirmed)}</span>
        </p>
      ) : (
        matches.length > 0 && (
          <ul aria-label={`${info.label} matches`} className="max-w-xl divide-y divide-hairline rounded-md border border-hairline">
            {matches.slice(0, SHOWN_MATCHES).map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => choose(m)} className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-wash">
                  <span className="shrink-0 font-medium text-ink">{m.symbol}</span>
                  <span className="truncate text-xs text-ink-2">{describeMatch(m)}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      {problem && !matches.length && !search.isFetching ? (
        <p className="flex items-start gap-1.5 text-xs text-ink">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          {problem}
        </p>
      ) : (
        <p className="text-xs text-ink-2">
          Type a name to search {info.label}, or its symbol: {info.examples}
        </p>
      )}
    </form>
  );
}
