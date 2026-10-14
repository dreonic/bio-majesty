import * as Popover from '@radix-ui/react-popover';
import type { Category } from '@bio-majesty/shared';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';

/** Category tags as removable chips, with a + button to add more. */
export function TagEditor({ value, onChange, categories }: { value: string[]; onChange: (ids: string[]) => void; categories: Category[] }) {
  const [open, setOpen] = useState(false);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const current = value.map((id) => byId.get(id)).filter((c): c is Category => Boolean(c));
  const addable = categories.filter((c) => !value.includes(c.id));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {current.length === 0 && <span className="text-xs text-muted">No tags</span>}
      {current.map((c) => (
        <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface py-0.5 pr-1 pl-2 text-xs text-ink">
          <span className="size-2 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
          {c.name}
          <button
            type="button"
            onClick={() => onChange(value.filter((id) => id !== c.id))}
            className="rounded-full p-0.5 text-muted hover:bg-wash hover:text-ink"
            aria-label={`Remove tag ${c.name}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className="inline-flex size-6 items-center justify-center rounded-full border border-dashed border-axis text-ink-2 hover:border-accent hover:text-accent-strong"
          aria-label="Add a tag"
          title="Add a tag"
        >
          <Plus className="size-3.5" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} className="z-50 max-h-72 w-60 overflow-y-auto rounded-md border border-hairline bg-raised p-1 shadow-lg">
            {addable.length === 0 ? (
              <p className="px-2 py-2 text-xs text-ink-2">{categories.length ? 'All categories are already tagged.' : 'No categories yet — add them in Settings.'}</p>
            ) : (
              addable.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onChange([...value, c.id]);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-wash"
                >
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
                  <span className="truncate">{c.name}</span>
                </button>
              ))
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
