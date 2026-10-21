import {
  candleDate,
  displaySymbol,
  INTRADAY_RANGES,
  intervalLabel,
  STOCK_RANGES,
  type Candle,
  type StockAsset,
  type StockExportInterval,
  type StockRange,
  type VolumeAnomaly,
} from '@bio-majesty/shared';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, BellRing, ChevronDown, ChevronRight, Clock, Download, PanelRightClose, Settings, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { MenuSelect } from '../../components/overlays';
import { useToast } from '../../components/toast';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { downloadFile } from '../../lib/download';
import { formatClock, formatCompact, formatDate, formatPercent, formatPrice, formatSigned, formatTime, timeZoneLabel } from '../../lib/format';
import { useStoredState } from '../../lib/hooks';
import { useAnomalies, useStock, useStockAssets, useStockExport } from '../../lib/queries';
import { StockChart } from './StockChart';

/** How the unusual-volume list names the span of each range. */
const RANGE_SPAN: Record<StockRange, string> = {
  '1D': 'on the last trading day',
  '5D': 'in the past 5 days',
  '1M': 'in the past month',
  '3M': 'in the past 3 months',
  '6M': 'in the past 6 months',
  '1Y': 'in the past year',
  '5Y': 'in the past 5 years',
  MAX: 'since listing',
};

/** The account's assets: pick one with the ticker dropdown. */
export function StockPanel({ onCollapse }: { onCollapse?: () => void }) {
  const assets = useStockAssets();
  const [stored, setStored] = useStoredState<string>('bm:stock-symbol', '');
  const items = assets.data ?? [];
  const asset = items.find((a) => a.symbol === stored) ?? items[0];

  if (assets.isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <Spinner />
      </div>
    );
  }
  if (!asset) {
    return (
      <div className="flex h-full flex-col bg-surface">
        {onCollapse && (
          <div className="flex justify-end px-3 pt-3">
            <CollapseButton onCollapse={onCollapse} />
          </div>
        )}
        <EmptyState icon={<BarChart3 className="size-8" />} title="No assets yet">
          Add a stock, index, currency or other asset in <Link to="/settings" className="text-accent-strong hover:underline">Settings</Link> to follow its price here.
        </EmptyState>
      </div>
    );
  }
  return <AssetView key={asset.symbol} asset={asset} assets={items} onSelect={setStored} onCollapse={onCollapse} />;
}

function CollapseButton({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button onClick={onCollapse} className="rounded-md p-1 text-muted hover:bg-wash hover:text-ink" aria-label="Collapse the stock panel" title="Collapse panel">
      <PanelRightClose className="size-4" />
    </button>
  );
}

/** Quote, chart (or table), unusual-volume days and downloads of one asset. */
function AssetView({
  asset,
  assets,
  onSelect,
  onCollapse,
}: {
  asset: StockAsset;
  assets: StockAsset[];
  onSelect: (symbol: string) => void;
  onCollapse?: () => void;
}) {
  const [storedRange, setRange] = useStoredState<StockRange>('bm:stock-range', '3M');
  const ranges = asset.intradayInterval ? STOCK_RANGES : STOCK_RANGES.filter((r) => !INTRADAY_RANGES.includes(r));
  // Daily-only assets (e.g. mutual funds) have no 1D/5D view.
  const range = ranges.includes(storedRange) ? storedRange : '3M';
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const stock = useStock(asset.symbol, range);
  const data = stock.data;
  const intraday = data?.interval === '15m';
  // Trading date of the first candle (the API reads it on the asset's calendar): the
  // unusual-volume list covers the same span as the chart.
  const firstDay = data?.candles.length ? candleDate(data.candles[0]!.time) : null;
  const anomalies = useAnomalies(asset.hasVolume ? asset.symbol : null, firstDay);
  const highlightTimes = useMemo(() => new Set((anomalies.data?.items ?? []).map((a) => a.time)), [anomalies.data]);
  const q = data?.quote;
  const up = (q?.change ?? 0) >= 0;
  const price = (n: number) => formatPrice(n, asset.decimals);

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="shrink-0 border-b border-hairline px-4 pt-3 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <MenuSelect
              label="Choose an asset"
              value={asset.symbol}
              onChange={onSelect}
              options={assets.map((a) => ({
                value: a.symbol,
                label: displaySymbol(a.symbol),
                detail: [a.name, a.exchange].filter(Boolean).join(' · ') || a.symbol,
              }))}
              footer={
                <Link to="/settings" className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-ink-2 hover:bg-wash hover:text-ink">
                  <Settings className="size-3.5" aria-hidden /> Add or remove assets in Settings
                </Link>
              }
              className="-ml-1 px-1 py-0.5"
            >
              <span className="truncate text-sm font-semibold text-ink">
                {displaySymbol(asset.symbol)}
                {asset.exchange && <span className="font-normal text-ink-2"> · {asset.exchange}</span>}
              </span>
            </MenuSelect>
            {asset.name && <p className="truncate text-xs text-ink-2">{asset.name}</p>}
          </div>
          <div className="flex items-start gap-1">
            <div className="flex flex-col items-end gap-1">
              <span className="inline-flex items-center gap-1 rounded-full bg-wash px-2 py-0.5 text-[11px] text-ink-2" title="Prices are delayed (free data source)">
                <Clock className="size-3" aria-hidden /> Delayed
              </span>
              {data?.stale && (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning-wash px-2 py-0.5 text-[11px] text-ink" title={data.lastError ?? undefined}>
                  <AlertTriangle className="size-3 text-warning" aria-hidden /> Not updating
                </span>
              )}
            </div>
            {onCollapse && <CollapseButton onCollapse={onCollapse} />}
          </div>
        </div>
        {q ? (
          <div className="mt-2">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-[44px] leading-none font-semibold text-ink">{price(q.price)}</span>
              {q.change !== null && (
                <span className={cn('inline-flex items-center gap-0.5 text-base font-semibold', up ? 'text-good-text' : 'text-critical')}>
                  {up ? <ArrowUpRight className="size-4" aria-hidden /> : <ArrowDownRight className="size-4" aria-hidden />}
                  {formatSigned(q.change, asset.decimals)} ({formatPercent(q.changePercent ?? 0)})
                  <span className="sr-only">{up ? 'up' : 'down'} today</span>
                </span>
              )}
            </div>
            <p className="tabular mt-1.5 text-xs text-ink-2">
              {q.currency ?? asset.currency ?? ''}
              {asset.hasVolume ? ` · Vol ${q.volume !== null ? formatCompact(q.volume) : '—'}` : ''}
              {q.dayLow !== null && q.dayHigh !== null ? ` · Day ${price(q.dayLow)}–${price(q.dayHigh)}` : ''}
              {q.previousClose !== null ? ` · Prev ${price(q.previousClose)}` : ''}
            </p>
            <p className="mt-0.5 text-[11px] text-muted">
              {q.marketTime ? `Market time ${formatDate(q.marketTime)} ${formatTime(q.marketTime)}` : ''} · via {q.provider}
            </p>
          </div>
        ) : (
          !stock.isLoading && <p className="mt-2 text-sm text-ink-2">No quote yet — data loads after the first refresh (within 15 minutes).</p>
        )}
      </header>

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex flex-wrap gap-0.5" role="group" aria-label="Range">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              aria-pressed={range === r}
              className={cn('h-7 rounded px-2 text-xs font-medium', range === r ? 'bg-ink text-white' : 'text-ink-2 hover:bg-wash')}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border border-hairline bg-raised p-0.5" role="group" aria-label="View">
          <button onClick={() => setView('chart')} aria-pressed={view === 'chart'} className={cn('rounded p-1', view === 'chart' ? 'bg-wash text-ink' : 'text-muted')} title="Chart">
            <BarChart3 className="size-4" />
          </button>
          <button onClick={() => setView('table')} aria-pressed={view === 'table'} className={cn('rounded p-1', view === 'table' ? 'bg-wash text-ink' : 'text-muted')} title="Table">
            <Table2 className="size-4" />
          </button>
        </div>
      </div>

      <div className={cn('relative min-h-56 flex-1 transition-opacity', stock.isPlaceholderData && 'opacity-60')}>
        {stock.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : !data?.candles.length ? (
          <EmptyState title="No price data for this range yet">
            {data?.lastError ? `Last refresh error: ${data.lastError}` : `Intraday data appears during ${asset.exchange ?? 'the market'}'s trading hours.`}
          </EmptyState>
        ) : view === 'chart' ? (
          <StockChart candles={data.candles} intraday={intraday} decimals={asset.decimals} highlightTimes={highlightTimes} />
        ) : (
          <CandleTable candles={data.candles} intraday={intraday} decimals={asset.decimals} />
        )}
      </div>

      {view === 'chart' && !intraday && asset.hasVolume && (
        <p className="shrink-0 border-t border-hairline px-4 py-2.5 text-xs text-ink-2">Bold volume bars = unusual volume.</p>
      )}

      {asset.hasVolume && <AnomalyList items={anomalies.data?.items ?? []} minRatio={anomalies.data?.minRatio} span={RANGE_SPAN[range]} />}
      <Downloads asset={asset} />
    </div>
  );
}

/** Days in the selected range whose trading volume was far above the 20-day average (newest first). */
function AnomalyList({ items, minRatio, span }: { items: VolumeAnomaly[]; minRatio?: number; span: string }) {
  const [open, setOpen] = useStoredState('bm:anomalies-open', true);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, 4);
  return (
    <section className="shrink-0 border-t border-hairline px-4 py-2.5 text-xs" aria-label="Unusual trading volume">
      <button className="flex w-full items-center gap-1.5 text-left font-medium text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        Unusual volume
        <span className="font-normal text-ink-2">
          · {items.length} {span}
          {minRatio ? ` (≥ ${minRatio}× the 20-day average)` : ''}
        </span>
      </button>
      {open && (
        <div className="mt-2">
          {items.length === 0 ? (
            <p className="text-ink-2">No unusual trading volume {span}.</p>
          ) : (
            <table className="tabular w-full">
              <tbody>
                {shown.map((a) => (
                  <tr key={a.date} className="border-b border-grid/60 last:border-0">
                    <td className="py-1 pr-2 text-ink">
                      {formatDate(a.time * 1000)}
                      {a.source === 'intraday' && <span className="ml-1 rounded bg-accent-wash px-1 text-[10px] text-accent-strong">today</span>}
                    </td>
                    <td className="py-1 pr-2 text-right font-medium text-ink">{a.ratio.toFixed(1)}×</td>
                    <td className="py-1 pr-2 text-right text-ink-2">{formatCompact(a.volume)}</td>
                    <td className={cn('py-1 pr-2 text-right', (a.changePercent ?? 0) >= 0 ? 'text-good-text' : 'text-critical')}>
                      {a.changePercent !== null ? formatPercent(a.changePercent) : '—'}
                    </td>
                    <td className="w-4 py-1 text-right">
                      {a.notifiedAt && (
                        <span title={`Telegram alert sent ${formatDate(a.notifiedAt)} ${formatTime(a.notifiedAt)}`}>
                          <BellRing className="inline size-3 text-muted" aria-label="Telegram alert sent" />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {items.length > 4 && (
            <button className="mt-1 text-accent-strong hover:underline" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : `Show all ${items.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * CSV downloads, whatever range the chart shows: every daily bar, and the intraday bars the
 * market-data source still has (the last 60 days, fetched when asked).
 */
function Downloads({ asset }: { asset: StockAsset }) {
  const exportCsv = useStockExport();
  const toast = useToast();
  const downloads: { interval: StockExportInterval; label: string; title: string }[] = [
    { interval: '1d', label: 'Daily', title: 'Every daily bar since listing' },
    ...(asset.intradayInterval
      ? [{ interval: 'intraday' as const, label: intervalLabel(asset.intradayInterval), title: 'The last 60 days, downloaded from the market-data source' }]
      : []),
  ];
  const download = (interval: StockExportInterval) =>
    exportCsv.mutateAsync({ symbol: asset.symbol, interval }).then(({ filename, csv }) => downloadFile(filename, csv), toast.error);

  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-hairline px-4 py-2 text-xs text-ink-2">
      <span>Download (CSV)</span>
      {downloads.map((d) => (
        <Button
          key={d.interval}
          size="sm"
          icon={<Download className="size-4" />}
          loading={exportCsv.isPending && exportCsv.variables?.interval === d.interval}
          disabled={exportCsv.isPending}
          onClick={() => void download(d.interval)}
          title={d.title}
        >
          {d.label}
        </Button>
      ))}
    </footer>
  );
}

function CandleTable({ candles, intraday, decimals }: { candles: Candle[]; intraday: boolean; decimals: number }) {
  // Every bar in the selected range, newest first.
  const rows = [...candles].reverse();
  const price = (n: number) => formatPrice(n, decimals);
  return (
    <div className="h-full overflow-auto px-3 pb-3">
      <table className="tabular w-full text-xs">
        <thead className="sticky top-0 bg-surface text-left text-ink-2">
          <tr className="border-b border-grid">
            <th className="py-1.5 pr-2 font-medium">{intraday ? `Time (${timeZoneLabel()})` : 'Date'}</th>
            <th className="py-1.5 pr-2 text-right font-medium">Open</th>
            <th className="py-1.5 pr-2 text-right font-medium">High</th>
            <th className="py-1.5 pr-2 text-right font-medium">Low</th>
            <th className="py-1.5 pr-2 text-right font-medium">Close</th>
            <th className="py-1.5 text-right font-medium">Volume</th>
          </tr>
        </thead>
        <tbody className="text-ink">
          {rows.map((c) => (
            <tr key={c.time} className="border-b border-grid/60">
              <td className="py-1 pr-2">{intraday ? `${formatDate(c.time * 1000)} ${formatClock(c.time * 1000)}` : formatDate(c.time * 1000)}</td>
              <td className="py-1 pr-2 text-right">{price(c.open)}</td>
              <td className="py-1 pr-2 text-right">{price(c.high)}</td>
              <td className="py-1 pr-2 text-right">{price(c.low)}</td>
              <td className={cn('py-1 pr-2 text-right', c.close >= c.open ? 'text-good-text' : 'text-critical')}>{price(c.close)}</td>
              <td className="py-1 text-right">{formatCompact(c.volume)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
