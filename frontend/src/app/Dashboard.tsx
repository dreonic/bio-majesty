import { CandlestickChart, Inbox, MessageSquare, Newspaper, PanelRightOpen } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import { useSearchParams } from 'react-router';
import { DigestBanner } from '../features/digest/DigestBanner';
import { NewsTab } from '../features/news/NewsTab';
import { ReviewTab } from '../features/review/ReviewTab';
import { StockPanel } from '../features/stock/StockPanel';
import { Spinner } from '../components/ui';
import { cn } from '../lib/cn';
import { useMediaQuery } from '../lib/hooks';
import { useCounts } from '../lib/queries';
import type { RuntimeConfig } from './config';

const ChatTab = lazy(() => import('../features/chat/ChatTab').then((m) => ({ default: m.ChatTab })));

type Tab = 'news' | 'review' | 'chat' | 'stock';

/**
 * News / Review / Chat tabs on the left, PRDA stock on the right with a
 * draggable divider and a collapse button (sizes persist in localStorage).
 * Below 1024px the stock panel becomes a fourth tab.
 */
export function Dashboard({ config }: { config: RuntimeConfig }) {
  const wide = useMediaQuery('(min-width: 1024px)');
  const [params, setParams] = useSearchParams();
  const requested = (params.get('tab') as Tab | null) ?? 'news';
  const tab: Tab = !wide || requested !== 'stock' ? requested : 'news';
  const setTab = (t: Tab) => setParams(t === 'news' ? {} : { tab: t }, { replace: true });
  const layout = useDefaultLayout({ id: 'bm-dashboard', storage: localStorage });
  const stockRef = usePanelRef();
  const [stockCollapsed, setStockCollapsed] = useState(false);

  const main = (
    <div className="flex h-full min-w-0 flex-col">
      <TabBar tab={tab} onChange={setTab} showStock={!wide} onExpandStock={wide && stockCollapsed ? () => stockRef.current?.expand() : undefined} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'news' && <NewsTab />}
        {tab === 'review' && <ReviewTab />}
        {tab === 'chat' && (
          <Suspense fallback={<Spinner className="m-8" />}>
            <ChatTab config={config} />
          </Suspense>
        )}
        {tab === 'stock' && <StockPanel />}
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <DigestBanner onReview={() => setTab('review')} />
      <div className="min-h-0 flex-1">
        {wide ? (
          <Group orientation="horizontal" id="bm-dashboard" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="h-full">
            <Panel id="main" minSize="40" className="h-full">
              {main}
            </Panel>
            <Separator className="group relative w-1.5 bg-hairline transition-colors hover:bg-accent/40 data-[separator=active]:bg-accent/60">
              <span className="absolute top-1/2 left-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-axis group-hover:bg-accent" aria-hidden />
            </Separator>
            <Panel
              id="stock"
              panelRef={stockRef}
              defaultSize="32"
              minSize="22"
              maxSize="55"
              collapsible
              collapsedSize="0"
              onResize={(size) => setStockCollapsed(size.asPercentage < 1)}
              // relative: the scroll area must contain absolutely positioned children (e.g. sr-only text),
              // otherwise they escape the collapsed 0px panel and widen the page.
              className="relative h-full"
            >
              <StockPanel onCollapse={() => stockRef.current?.collapse()} />
            </Panel>
          </Group>
        ) : (
          main
        )}
      </div>
    </div>
  );
}

function TabBar({
  tab,
  onChange,
  showStock,
  onExpandStock,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  showStock: boolean;
  onExpandStock?: () => void;
}) {
  const counts = useCounts();
  const pending = counts.data?.pending ?? 0;
  const tabs: { id: Tab; label: string; Icon: typeof Newspaper; badge?: number }[] = [
    { id: 'news', label: 'News', Icon: Newspaper },
    { id: 'review', label: 'Review', Icon: Inbox, badge: pending },
    { id: 'chat', label: 'Chat', Icon: MessageSquare },
    ...(showStock ? [{ id: 'stock' as Tab, label: 'Stock', Icon: CandlestickChart }] : []),
  ];
  return (
    <div className="flex shrink-0 items-end gap-1 border-b border-hairline bg-raised px-3" role="tablist" aria-label="Dashboard sections">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            '-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors',
            tab === t.id ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink',
          )}
        >
          <t.Icon className="size-4" aria-hidden />
          {t.label}
          {t.badge ? (
            <span className="rounded-full bg-accent px-1.5 py-px text-xs font-semibold text-white" aria-label={`${t.badge} to review`}>
              {t.badge}
            </span>
          ) : null}
        </button>
      ))}
      {onExpandStock && (
        <button
          onClick={onExpandStock}
          className="mb-1.5 ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-ink-2 hover:bg-wash hover:text-ink"
          title="Show the stock panel"
        >
          <PanelRightOpen className="size-4" aria-hidden /> Show stock
        </button>
      )}
    </div>
  );
}
