import { type Article, type Category } from '@bio-majesty/shared';
import { Check, ChevronDown, ChevronRight, Inbox, Keyboard, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from '../../components/overlays';
import { useToast } from '../../components/toast';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatDate, formatDateTime, relativeTime } from '../../lib/format';
import { useBulkReview, useCategories, useCounts, useNews, useReview } from '../../lib/queries';
import { ArticleCard, type ArticleCardHandle } from '../news/ArticleCard';
import { useChartFocus } from '../stock/chart-focus';

/**
 * Review queue: every AI-suggested article waits here until the exec saves
 * (with optional edits) or skips it. Skipped articles go to the recycle bin,
 * where they can be restored. Keyboard: J/K move, S save, X skip, E details.
 */
export function ReviewTab() {
  const pending = useNews({ status: 'PENDING', limit: 100 });
  const categories = useCategories().data ?? [];
  const counts = useCounts();
  const bulk = useBulkReview();
  const toast = useToast();
  const items = useMemo(() => pending.data?.pages.flatMap((p) => p.items) ?? [], [pending.data]);
  const groups = useMemo(() => groupByOrigin(items, categories), [items, categories]);
  const [focus, setFocus] = useState(0);
  const [binOpen, setBinOpen] = useState(false);
  const cardRefs = useRef(new Map<string, ArticleCardHandle>());
  const skipped = counts.data?.skipped ?? 0;

  // Once the exec clicks a card or moves with J/K, the chart highlights the focused card
  // (and keeps following it when Save/Skip moves the focus to the next one).
  const { focus: focusChart } = useChartFocus();
  const [followChart, setFollowChart] = useState(false);
  const current = items[focus];
  useEffect(() => {
    if (followChart) focusChart(current ?? null);
  }, [followChart, current, focusChart]);

  useEffect(() => {
    if (focus >= items.length) setFocus(Math.max(0, items.length - 1));
  }, [items.length, focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [role="dialog"], [role="menu"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const current = items[focus];
      if (e.key === 'j' || e.key === 'k') {
        setFocus((f) => (e.key === 'j' ? Math.min(items.length - 1, f + 1) : Math.max(0, f - 1)));
        setFollowChart(true);
      } else if (current && e.key === 's') cardRefs.current.get(current.id)?.save();
      else if (current && e.key === 'x') cardRefs.current.get(current.id)?.skip();
      else if (current && e.key === 'e') cardRefs.current.get(current.id)?.details();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, focus]);

  const saveAll = () => {
    const ids = items.filter((a) => a.suggestion).map((a) => a.id);
    if (!ids.length) return;
    bulk.mutate(
      { ids: ids.slice(0, 100), action: 'approve' },
      {
        onSuccess: (res) => toast.success(`Saved ${res.updated} article${res.updated === 1 ? '' : 's'} with the AI's tags`),
        onError: toast.error,
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline bg-surface px-4 py-3">
        <p className="text-sm text-ink-2">
          <span className="font-semibold text-ink">{counts.data?.pending ?? items.length}</span> waiting for review
        </p>
        <span className="hidden items-center gap-1 text-xs text-muted md:inline-flex" title="Keyboard shortcuts">
          <Keyboard className="size-3.5" aria-hidden /> J/K move · S save · X skip · E details
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setBinOpen(true)} icon={<Trash2 className="size-4" />} title="News you skipped">
            Recycle bin{skipped ? ` (${skipped})` : ''}
          </Button>
          <Button size="sm" onClick={saveAll} loading={bulk.isPending} disabled={!items.some((a) => a.suggestion)} icon={<Check className="size-4" />}>
            Save all as suggested
          </Button>
        </div>
      </div>
      <Sheet
        open={binOpen}
        onOpenChange={setBinOpen}
        title="Recycle bin"
        description="News you skipped. It stays here so later runs don't bring it back; restore an article to review it again."
      >
        <RestorableList status="REJECTED" />
      </Sheet>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {pending.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Inbox className="size-8" />} title="You're all caught up">
            New articles appear here after each daily run or category backfill.
          </EmptyState>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {groups.map((g) => (
              <section key={g.key} className="space-y-3">
                <h3 className="text-xs font-semibold tracking-wide text-ink-2 uppercase">{g.label}</h3>
                {g.items.map((a) => {
                  const index = items.indexOf(a);
                  return (
                    <ReviewItem
                      key={a.id}
                      article={a}
                      categories={categories}
                      focused={index === focus}
                      onFocus={() => {
                        setFocus(index);
                        setFollowChart(true);
                      }}
                      handleRef={(h) => {
                        if (h) cardRefs.current.set(a.id, h);
                        else cardRefs.current.delete(a.id);
                      }}
                    />
                  );
                })}
              </section>
            ))}
            {pending.hasNextPage && (
              <div className="flex justify-center">
                <Button onClick={() => void pending.fetchNextPage()} loading={pending.isFetchingNextPage}>
                  Load more
                </Button>
              </div>
            )}
          </div>
        )}
        <FilteredSection count={counts.data?.filtered ?? 0} />
      </div>
    </div>
  );
}

function groupByOrigin(items: Article[], categories: Category[]) {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const groups = new Map<string, { key: string; label: string; items: Article[] }>();
  for (const a of items) {
    const key = a.origin.type === 'backfill' ? `backfill:${a.origin.runId}` : `daily:${formatDate(a.createdAt)}`;
    const label =
      a.origin.type === 'backfill'
        ? `Backfill · ${names.get(a.origin.categoryId ?? '') ?? 'category'}`
        : `Daily run · ${formatDate(a.createdAt)}`;
    const g = groups.get(key) ?? { key, label, items: [] };
    g.items.push(a);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Scrolls the focused card into view (keyboard navigation). */
function ReviewItem({
  focused,
  ...props
}: Omit<Parameters<typeof ArticleCard>[0], 'mode'>) {
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) elRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  return (
    <div ref={elRef}>
      <ArticleCard {...props} focused={focused} mode="review" />
    </div>
  );
}

/** Items the AI prefilter dropped — visible and restorable for 30 days. */
function FilteredSection({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <section className="mx-auto mt-8 max-w-3xl border-t border-hairline pt-4">
      <button className="flex items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        Filtered by AI ({count})
      </button>
      {open && <RestorableList status="FILTERED" className="mt-3" />}
    </section>
  );
}

/** Filtered (by the AI) or skipped (by the exec) articles, each restorable to the review queue. */
function RestorableList({ status, className }: { status: 'FILTERED' | 'REJECTED'; className?: string }) {
  const list = useNews({ status, limit: 50 });
  const review = useReview();
  const toast = useToast();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.isLoading) return <Spinner className={className} />;
  if (!items.length && status === 'REJECTED') {
    return (
      <EmptyState icon={<Trash2 className="size-8" />} title="The recycle bin is empty">
        Articles you skip in the review queue appear here.
      </EmptyState>
    );
  }
  return (
    <ul className={cn('divide-y divide-hairline rounded-lg border border-hairline bg-raised', className)}>
      {items.map((a) => (
        <li key={a.id} className="flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <a href={a.url} target="_blank" rel="noreferrer noopener" className="text-sm font-medium text-ink hover:underline">
              {a.title}
            </a>
            <p className="mt-0.5 text-xs text-ink-2">
              {a.sourceName ?? a.sourceDomain} · {formatDateTime(a.publishedAt)} ·{' '}
              {status === 'FILTERED' ? a.filterReason : a.reviewedAt ? `skipped ${relativeTime(a.reviewedAt)}` : 'skipped'}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw className="size-4" />}
            onClick={() => review.mutate({ id: a.id, action: 'restore' }, { onSuccess: () => toast.success('Restored to review'), onError: toast.error })}
          >
            Restore
          </Button>
        </li>
      ))}
      {list.hasNextPage && (
        <li className="px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
            Load more
          </Button>
        </li>
      )}
    </ul>
  );
}
