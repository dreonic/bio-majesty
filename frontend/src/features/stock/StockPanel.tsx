import { STOCK_RANGES, type Candle, type StockRange, type VolumeAnomaly } from '@bio-majesty/shared';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, BellRing, ChevronDown, ChevronRight, Clock, PanelRightClose, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SENTIMENT_META, SentimentBadge } from '../../components/tags';
import { EmptyState, Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatCompact, formatDate, formatPercent, formatPrice, formatSigned, formatTime, jakartaYmd } from '../../lib/format';
import { useStoredState } from '../../lib/hooks';
import { useAnomalies, useStock, useStockMarkers } from '../../lib/queries';
import { useOpenArticle } from '../news/ArticleSheet';
import { StockChart } from './StockChart';

/** PRDA quote, chart (or table), unusual-volume days and the saved news plotted on the chart. */
export function StockPanel({ onCollapse }: { onCollapse?: () => void }) {
  const [range, setRange] = useStoredState<StockRange>('bm:stock-range', '3M');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const stock = useStock(range);
  const anomalies = useAnomalies();
  const data = stock.data;
  const intraday = data?.interval === '15m';
  const markersFrom = !intraday && data?.candles.length ? jakartaYmd(new Date(data.candles[0]!.time * 1000)) : null;
  const markers = useStockMarkers(markersFrom).data ?? [];
  const dayNews = useMemo(() => (selectedDay ? markers.filter((m) => m.time === selectedDay) : []), [markers, selectedDay]);
  const highlightTimes = useMemo(() => new Set((anomalies.data?.items ?? []).map((a) => a.time)), [anomalies.data]);
  const openArticle = useOpenArticle();
  const q = data?.quote;
  const up = (q?.change ?? 0) >= 0;

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="shrink-0 border-b border-hairline px-4 pt-3 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-ink">
              {data?.symbol.replace('.JK', '') ?? 'PRDA'} <span className="font-normal text-ink-2">· IDX</span>
            </p>
            <p className="text-xs text-ink-2">PT Prodia Widyahusada Tbk</p>
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
            {onCollapse && (
              <button onClick={onCollapse} className="rounded-md p-1 text-muted hover:bg-wash hover:text-ink" aria-label="Collapse the stock panel" title="Collapse panel">
                <PanelRightClose className="size-4" />
              </button>
            )}
          </div>
        </div>
        {q ? (
          <div className="mt-2">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-[44px] leading-none font-semibold text-ink">{formatPrice(q.price)}</span>
              {q.change !== null && (
                <span className={cn('inline-flex items-center gap-0.5 text-base font-semibold', up ? 'text-good-text' : 'text-critical')}>
                  {up ? <ArrowUpRight className="size-4" aria-hidden /> : <ArrowDownRight className="size-4" aria-hidden />}
                  {formatSigned(q.change)} ({formatPercent(q.changePercent ?? 0)})
                  <span className="sr-only">{up ? 'up' : 'down'} today</span>
                </span>
              )}
            </div>
            <p className="tabular mt-1.5 text-xs text-ink-2">
              {q.currency ?? 'IDR'} · Vol {q.volume !== null ? formatCompact(q.volume) : '—'}
              {q.dayLow !== null && q.dayHigh !== null ? ` · Day ${formatPrice(q.dayLow)}–${formatPrice(q.dayHigh)}` : ''}
              {q.previousClose !== null ? ` · Prev ${formatPrice(q.previousClose)}` : ''}
            </p>
            <p className="mt-0.5 text-[11px] text-muted">
              {q.marketTime ? `Market time ${formatDate(q.marketTime)} ${formatTime(q.marketTime)}` : ''} · via {q.provider}
            </p>
          </div>
        ) : (
          !stock.isLoading && <p className="mt-2 text-sm text-ink-2">No quote yet — data loads after the first scheduled refresh.</p>
        )}
      </header>

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex flex-wrap gap-0.5" role="group" aria-label="Range">
          {STOCK_RANGES.map((r) => (
            <button
              key={r}
              onClick={() => {
                setRange(r);
                setSelectedDay(null);
              }}
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
            {data?.lastError ? `Last refresh error: ${data.lastError}` : 'Intraday data appears during IDX trading hours.'}
          </EmptyState>
        ) : view === 'chart' ? (
          <StockChart candles={data.candles} intraday={intraday} markers={markers} highlightTimes={highlightTimes} onDaySelected={setSelectedDay} />
        ) : (
          <CandleTable candles={data.candles} intraday={intraday} />
        )}
      </div>

      {view === 'chart' && !intraday && (
        <div className="shrink-0 border-t border-hairline px-4 py-2.5 text-xs">
          {selectedDay && dayNews.length ? (
            <div className="space-y-1.5">
              <p className="font-medium text-ink">Saved news on {formatDate(selectedDay * 1000)}</p>
              {dayNews.map((m) => (
                <button key={m.articleId} onClick={() => openArticle(m.articleId)} className="flex w-full items-start gap-2 text-left hover:underline">
                  <SentimentBadge sentiment={m.sentiment} className="shrink-0" />
                  <span className="line-clamp-2 text-ink">{m.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-ink-2">
              Saved news: <MarkerKey symbol="▲" sentiment="positive" /> · <MarkerKey symbol="▼" sentiment="negative" /> · <MarkerKey symbol="●" sentiment="neutral" /> ·{' '}
              <MarkerKey symbol="■" sentiment="undecided" />. Bold volume bars = unusual volume. Click a day to see its articles.
            </p>
          )}
        </div>
      )}

      <AnomalyList items={anomalies.data?.items ?? []} minRatio={anomalies.data?.minRatio} onSelectDay={setSelectedDay} />
    </div>
  );
}

function MarkerKey({ symbol, sentiment }: { symbol: string; sentiment: keyof typeof SENTIMENT_META }) {
  return (
    <span className="whitespace-nowrap">
      <span style={{ color: SENTIMENT_META[sentiment].color }} aria-hidden>
        {symbol}
      </span>{' '}
      {SENTIMENT_META[sentiment].label.toLowerCase()}
    </span>
  );
}

/** Days whose trading volume was far above the 20-day average (newest first). */
function AnomalyList({ items, minRatio, onSelectDay }: { items: VolumeAnomaly[]; minRatio?: number; onSelectDay: (time: number) => void }) {
  const [open, setOpen] = useStoredState('bm:anomalies-open', true);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, 4);
  return (
    <section className="shrink-0 border-t border-hairline px-4 py-2.5 text-xs" aria-label="Unusual trading volume">
      <button className="flex w-full items-center gap-1.5 text-left font-medium text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        Unusual volume
        <span className="font-normal text-ink-2">
          · {items.length} in 12 months{minRatio ? ` (≥ ${minRatio}× the 20-day average)` : ''}
        </span>
      </button>
      {open && (
        <div className="mt-2">
          {items.length === 0 ? (
            <p className="text-ink-2">No unusual trading volume in the last 12 months.</p>
          ) : (
            <table className="tabular w-full">
              <tbody>
                {shown.map((a) => (
                  <tr key={a.date} className="cursor-pointer border-b border-grid/60 last:border-0 hover:bg-wash" onClick={() => onSelectDay(a.time)}>
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
                      {a.notifiedAt && <BellRing className="inline size-3 text-muted" aria-label="Alert sent" />}
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

function CandleTable({ candles, intraday }: { candles: Candle[]; intraday: boolean }) {
  const rows = [...candles].reverse().slice(0, 120);
  return (
    <div className="h-full overflow-auto px-3 pb-3">
      <table className="tabular w-full text-xs">
        <thead className="sticky top-0 bg-surface text-left text-ink-2">
          <tr className="border-b border-grid">
            <th className="py-1.5 pr-2 font-medium">{intraday ? 'Time (WIB)' : 'Date'}</th>
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
              <td className="py-1 pr-2">{intraday ? `${formatDate(c.time * 1000)} ${formatTime(c.time * 1000).replace(' WIB', '')}` : formatDate(c.time * 1000)}</td>
              <td className="py-1 pr-2 text-right">{formatPrice(c.open)}</td>
              <td className="py-1 pr-2 text-right">{formatPrice(c.high)}</td>
              <td className="py-1 pr-2 text-right">{formatPrice(c.low)}</td>
              <td className={cn('py-1 pr-2 text-right', c.close >= c.open ? 'text-good-text' : 'text-critical')}>{formatPrice(c.close)}</td>
              <td className="py-1 text-right">{formatCompact(c.volume)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
