import type { Category } from '@bio-majesty/shared';
import { History, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Modal } from '../../components/overlays';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, EmptyState, Field, SectionTitle, Select, Spinner } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useBackfill, useCategories, useDeleteCategory } from '../../lib/queries';
import { CategoryDialog } from './CategoryDialog';
import { BACKFILL_OPTIONS } from './constants';



export function CategoriesSection() {
  const categories = useCategories();
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [backfillFor, setBackfillFor] = useState<Category | null>(null);
  const remove = useDeleteCategory();
  const toast = useToast();

  return (
    <Card>
      <SectionTitle
        title="Categories"
        description="Each category has its own search queries and is also a tag the AI can assign. A historical search (backfill) runs when you add one; afterwards it joins the daily run."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add category
          </Button>
        }
      />
      {categories.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !categories.data?.length ? (
        <EmptyState title="No categories yet">Add a category for each topic you follow (a company, a person, an industry or a policy area), or start from a template in the Add dialog.</EmptyState>
      ) : (
        <ul className="divide-y divide-hairline">
          {categories.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
              <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{c.name}</span>
                  <StatusBadges category={c} />
                </div>
                {c.description && <p className="mt-0.5 text-sm text-ink-2">{c.description}</p>}
                <p className="mt-1 text-xs text-muted">
                  {c.search.enabled ? `${c.search.queries.length} quer${c.search.queries.length === 1 ? 'y' : 'ies'}: ${c.search.queries.map((q) => q.q).join(' · ')}` : 'Label only (not searched)'}
                </p>
                {c.backfill.error && <p className="mt-1 text-xs text-critical">Backfill error: {c.backfill.error}</p>}
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" icon={<History className="size-4" />} disabled={!c.search.enabled || c.backfill.status === 'running' || c.backfill.status === 'pending'} onClick={() => setBackfillFor(c)}>
                  Backfill
                </Button>
                <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(c)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 className="size-4" />}
                  aria-label={`Delete ${c.name}`}
                  onClick={() => {
                    if (window.confirm(`Delete "${c.name}"? Saved articles keep their other tags.`)) {
                      remove.mutate(c.id, { onSuccess: () => toast.success('Category deleted'), onError: toast.error });
                    }
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <CategoryDialog category={editing === 'new' ? null : editing} existingCount={categories.data?.length ?? 0} onClose={() => setEditing(null)} />}
      {backfillFor && <BackfillDialog category={backfillFor} onClose={() => setBackfillFor(null)} />}
    </Card>
  );
}

function StatusBadges({ category: c }: { category: Category }) {
  const b = c.backfill;
  return (
    <>
      {c.active ? <Badge>In daily run</Badge> : <Badge className="text-muted">Not in daily run</Badge>}
      {(b.status === 'running' || b.status === 'pending') && (
        <Badge className="border-accent/30 bg-accent-wash text-ink">
          <Spinner className="size-3" /> Backfilling {b.months} mo
        </Badge>
      )}
      {b.status === 'done' && b.completedAt && <Badge title={formatDateTime(b.completedAt)}>Backfilled {b.months} mo</Badge>}
      {b.status === 'failed' && <Badge className="border-critical/30 bg-critical-wash text-ink">Backfill failed</Badge>}
    </>
  );
}

function BackfillDialog({ category, onClose }: { category: Category; onClose: () => void }) {
  const [months, setMonths] = useState(category.backfill.months || 6);
  const backfill = useBackfill();
  const toast = useToast();
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Backfill “${category.name}”`}
      description="Search the past for this category. New articles go to the Review tab; you'll get a Telegram message when it finishes."
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={backfill.isPending}
            onClick={() =>
              backfill.mutate(
                { id: category.id, months },
                {
                  onSuccess: () => {
                    toast.success('Backfill started');
                    onClose();
                  },
                  onError: toast.error,
                },
              )
            }
          >
            Start backfill
          </Button>
        </>
      }
    >
      <Field label="Period" hint="Longer periods take longer and use more AI tokens. Google News returns at most ~100 results per query and window.">
        <Select value={months} onChange={(e) => setMonths(Number(e.target.value))} className="w-full">
          {BACKFILL_OPTIONS.map((m) => (
            <option key={m} value={m}>
              Last {m} month{m === 1 ? '' : 's'}
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  );
}
