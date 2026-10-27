import { type Article, type Category, type DeletableStatus } from '@bio-majesty/shared';
import { Check, ChevronDown, ChevronRight, Inbox, Keyboard, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from '../../components/overlays';
import { useToast } from '../../components/toast';
import { Button, Checkbox, EmptyState, Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatDate, formatDateTime, relativeTime } from '../../lib/format';
import { useBulkReview, useCategories, useCounts, useDeleteNews, useNews, useReview } from '../../lib/queries';
import { ArticleCard, type ArticleCardHandle } from '../news/ArticleCard';

/**
 * Review queue: every AI-suggested article waits here until the reviewer saves
 * (with optional edits) or skips it. Skipped articles go to the recycle bin (later runs
 * leave them out while they are there), where they can be restored or deleted for good
 * (then a later run may find them again). Keyboard: J/K move, S save, X skip, E details.
 */
export function ReviewTab() {
  const pending = useNews({ status: 'PENDING', limit: 100 });
  const categories = useCategories().data ?? [];
  const counts = useCounts();
  const bulk = useBulkReview();
  const purge = useDeleteNews();
  const toast = useToast();
  const items = useMemo(() => pending.data?.pages.flatMap((p) => p.items) ?? [], [pending.data]);
  const groups = useMemo(() => groupByOrigin(items, categories), [items, categories]);
  const [focus, setFocus] = useState(0);
  const [binOpen, setBinOpen] = useState(false);
  const cardRefs = useRef(new Map<string, ArticleCardHandle>());
  const skipped = counts.data?.skipped ?? 0;

  useEffect(() => {
    if (focus >= items.length) setFocus(Math.max(0, items.length - 1));
  }, [items.length, focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [role="dialog"], [role="menu"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const current = items[focus];
      if (e.key === 'j' || e.key === 'k') setFocus((f) => (e.key === 'j' ? Math.min(items.length - 1, f + 1) : Math.max(0, f - 1)));
      else if (current && e.key === 's') cardRefs.current.get(current.id)?.save();
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

  const emptyBin = () => {
    if (!window.confirm(`Delete all ${articleCount(skipped)} in the recycle bin for good? They may show up again in later runs or backfills.`)) return;
    purge.mutate(
      { status: 'REJECTED' },
      { onSuccess: (res) => toast.success(`Deleted ${articleCount(res.deleted)}`), onError: toast.error },
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
        description="News you skipped. It stays here until you delete it; restore an article to review it again. Later runs don't bring skipped or deleted news back."
        footer={
          <div className="flex justify-end">
            <Button size="sm" variant="danger" onClick={emptyBin} loading={purge.isPending} disabled={!skipped} icon={<Trash2 className="size-4" />}>
              Delete all
            </Button>
          </div>
        }
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
                      onFocus={() => setFocus(index)}
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

/** Items the AI prefilter dropped: kept for 30 days, to restore to review or delete sooner. */
function FilteredSection({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <section className="mx-auto mt-8 max-w-3xl border-t border-hairline pt-4">
      <button className="flex items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        Filtered by AI ({count})
      </button>
      {open && <RestorableList status="FILTERED" selectable className="mt-3" />}
    </section>
  );
}

const articleCount = (n: number) => `${n} article${n === 1 ? '' : 's'}`;

/** What deleting does to later runs: skipped news is forgotten, filtered news stays filtered out. */
const AFTER_DELETE: Record<DeletableStatus, string> = {
  REJECTED: 'They may show up again in later runs or backfills.',
  FILTERED: "They'll stay filtered out in later runs.",
};

/**
 * Filtered (by the AI) or skipped (by the reviewer) articles, each restorable to the review
 * queue. With `selectable`, articles can also be deleted (not to the recycle bin), one at a
 * time or picked with checkboxes and restored or deleted together.
 */
function RestorableList({ status, selectable = false, className }: { status: DeletableStatus; selectable?: boolean; className?: string }) {
  const list = useNews({ status, limit: 50 });
  const review = useReview();
  const bulk = useBulkReview();
  const removeOne = useDeleteNews();
  const removeChosen = useDeleteNews();
  const toast = useToast();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  // Restored or deleted articles leave the list, and with it the selection.
  const chosen = items.filter((a) => selected.has(a.id)).map((a) => a.id);
  const allChosen = items.length > 0 && chosen.length === items.length;

  if (list.isLoading) return <Spinner className={className} />;
  if (!items.length && status === 'REJECTED') {
    return (
      <EmptyState icon={<Trash2 className="size-8" />} title="The recycle bin is empty">
        Articles you skip in the review queue appear here.
      </EmptyState>
    );
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const restoreChosen = () =>
    bulk.mutate(
      { ids: chosen, action: 'restore' },
      {
        onSuccess: (res) => {
          setSelected(new Set());
          toast.success(`Restored ${articleCount(res.updated)} to review`);
        },
        onError: toast.error,
      },
    );
  const deleteChosen = () => {
    if (!window.confirm(`Delete ${articleCount(chosen.length)}? ${AFTER_DELETE[status]}`)) return;
    removeChosen.mutate(
      { ids: chosen },
      {
        onSuccess: (res) => {
          setSelected(new Set());
          toast.success(`Deleted ${articleCount(res.deleted)}`);
        },
        onError: toast.error,
      },
    );
  };

  return (
    <div className={cn('rounded-lg border border-hairline bg-raised', className)}>
      {selectable && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2">
          <label className="flex cursor-pointer items-center gap-3 text-sm text-ink-2">
            <Checkbox
              aria-label="Select all"
              checked={allChosen}
              indeterminate={chosen.length > 0 && !allChosen}
              onChange={() => setSelected(allChosen ? new Set() : new Set(items.map((a) => a.id)))}
            />
            {chosen.length ? `${chosen.length} selected` : 'Select all'}
          </label>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} disabled={!chosen.length} loading={bulk.isPending} onClick={restoreChosen}>
              Restore
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} disabled={!chosen.length} loading={removeChosen.isPending} onClick={deleteChosen}>
              Delete
            </Button>
          </div>
        </div>
      )}
      <ul className="divide-y divide-hairline">
        {items.map((a) => (
          <li key={a.id} className="flex items-start gap-3 px-4 py-3">
            {selectable && <Checkbox className="mt-0.5" aria-label={`Select "${a.title}"`} checked={selected.has(a.id)} onChange={() => toggle(a.id)} />}
            <div className="min-w-0 flex-1">
              <a href={a.url} target="_blank" rel="noreferrer noopener" className="text-sm font-medium text-ink hover:underline">
                {a.title}
              </a>
              <p className="mt-0.5 text-xs text-ink-2">
                {a.sourceName ?? a.sourceDomain} · {formatDateTime(a.publishedAt)} ·{' '}
                {status === 'FILTERED' ? a.filterReason : a.reviewedAt ? `skipped ${relativeTime(a.reviewedAt)}` : 'skipped'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                icon={<RotateCcw className="size-4" />}
                onClick={() => review.mutate({ id: a.id, action: 'restore' }, { onSuccess: () => toast.success('Restored to review'), onError: toast.error })}
              >
                Restore
              </Button>
              {selectable && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="hover:text-critical"
                  icon={<Trash2 className="size-4" />}
                  title={`Delete (not to the recycle bin). ${AFTER_DELETE[status]}`}
                  onClick={() => removeOne.mutate({ ids: [a.id] }, { onSuccess: () => toast.success('Deleted'), onError: toast.error })}
                >
                  Delete
                </Button>
              )}
            </div>
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
    </div>
  );
}
