import { SENTIMENTS, type Sentiment } from '@bio-majesty/shared';
import { Newspaper, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { MultiSelect } from '../../components/overlays';
import { SENTIMENT_META } from '../../components/tags';
import { Button, EmptyState, Input, Select, Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { daysAgo, jakartaYmd } from '../../lib/format';
import { useDebounced, useStoredState } from '../../lib/hooks';
import { useCategories, useNews } from '../../lib/queries';
import { ArticleCard } from './ArticleCard';

const WINDOWS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range…' },
] as const;

interface Filters {
  q: string;
  categories: string[];
  sentiments: Sentiment[];
  window: string;
  from: string;
  to: string;
}

const DEFAULT_FILTERS: Filters = { q: '', categories: [], sentiments: [], window: '30', from: '', to: '' };

/** Saved (approved) news with keyword, category, sentiment and time-window filters. */
export function NewsTab() {
  const [filters, setFilters] = useStoredState<Filters>('bm:news-filters', DEFAULT_FILTERS);
  const [q, setQ] = useState(filters.q);
  const debouncedQ = useDebounced(q, 350);
  const categories = useCategories().data ?? [];
  const update = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });

  const range = useMemo(() => {
    if (filters.window === 'all') return {};
    if (filters.window === 'custom') return { from: filters.from || undefined, to: filters.to || undefined };
    return { from: jakartaYmd(daysAgo(Number(filters.window))) };
  }, [filters.window, filters.from, filters.to]);

  const news = useNews({
    status: 'APPROVED',
    q: debouncedQ.trim() || undefined,
    categories: filters.categories,
    sentiments: filters.sentiments,
    ...range,
  });
  const items = news.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(debouncedQ || filters.categories.length || filters.sentiments.length);

  const toggleSentiment = (s: Sentiment) =>
    update({ sentiments: filters.sentiments.includes(s) ? filters.sentiments.filter((x) => x !== s) : [...filters.sentiments, s] });

  return (
    <div className="flex h-full flex-col">
      {/* One filter row scoping the list below */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-surface px-4 py-3">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              update({ q: e.target.value });
            }}
            placeholder="Search saved news"
            className="pl-8"
            aria-label="Keyword"
          />
        </div>
        <MultiSelect
          options={categories.map((c) => ({ value: c.id, label: c.name, color: c.color }))}
          value={filters.categories}
          onChange={(v) => update({ categories: v })}
          placeholder="All categories"
          className="w-44"
          emptyText="No categories yet — add them in Settings"
        />
        <div className="flex items-center gap-1" role="group" aria-label="Sentiment">
          {SENTIMENTS.map((s) => {
            const meta = SENTIMENT_META[s];
            const active = filters.sentiments.includes(s);
            return (
              <button
                key={s}
                onClick={() => toggleSentiment(s)}
                aria-pressed={active}
                className={cn(
                  'inline-flex h-9 items-center gap-1 rounded-md border px-2.5 text-sm transition-colors',
                  active ? 'border-accent bg-accent-wash text-ink' : 'border-hairline bg-raised text-ink-2 hover:bg-wash',
                )}
              >
                <meta.Icon className="size-3.5" style={{ color: meta.color }} aria-hidden strokeWidth={2.5} />
                {meta.label}
              </button>
            );
          })}
        </div>
        <Select value={filters.window} onChange={(e) => update({ window: e.target.value })} aria-label="Time window">
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
        {filters.window === 'custom' && (
          <div className="flex items-center gap-1">
            <Input type="date" value={filters.from} onChange={(e) => update({ from: e.target.value })} className="w-36" aria-label="From" />
            <span className="text-ink-2">–</span>
            <Input type="date" value={filters.to} onChange={(e) => update({ to: e.target.value })} className="w-36" aria-label="To" />
          </div>
        )}
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQ('');
              setFilters({ ...DEFAULT_FILTERS, window: filters.window, from: filters.from, to: filters.to });
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className={cn('flex-1 overflow-y-auto px-4 py-4 transition-opacity', news.isPlaceholderData && 'opacity-60')}>
        {news.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : news.isError ? (
          <EmptyState title="Could not load news">{news.error.message}</EmptyState>
        ) : items.length === 0 ? (
          <EmptyState icon={<Newspaper className="size-8" />} title={filtered ? 'No saved news matches these filters' : 'No saved news yet'}>
            {filtered ? 'Try a wider time window or fewer filters.' : 'Articles you save from the Review tab appear here.'}
          </EmptyState>
        ) : (
          <div className="mx-auto max-w-3xl space-y-3">
            {items.map((a) => (
              <ArticleCard key={a.id} article={a} categories={categories} mode="saved" />
            ))}
            {news.hasNextPage && (
              <div className="flex justify-center pt-2">
                <Button onClick={() => void news.fetchNextPage()} loading={news.isFetchingNextPage}>
                  Load more
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
