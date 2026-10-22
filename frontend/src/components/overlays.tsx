import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Input } from './ui';

/** Right-hand side sheet (article details, editors). */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'max-w-xl',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/20" />
        <Dialog.Content
          className={cn('fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-hairline bg-raised shadow-xl focus:outline-none', width)}
        >
          <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-ink">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-sm text-ink-2">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close className="rounded-md p-1 text-ink-2 hover:bg-wash" aria-label="Close">
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="border-t border-hairline px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Centered modal dialog. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'max-w-2xl',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30" />
        <Dialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-hairline bg-raised shadow-xl focus:outline-none',
            width,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-ink">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-sm text-ink-2">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close className="rounded-md p-1 text-ink-2 hover:bg-wash" aria-label="Close">
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface Option {
  value: string;
  label: string;
  color?: string;
}

/** Checkbox list in a popover (categories filter / editor). */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  className,
  emptyText = 'No options',
}: {
  options: Option[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  className?: string;
  emptyText?: string;
}) {
  const selected = options.filter((o) => value.includes(o.value));
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <Popover.Root>
      <Popover.Trigger
        className={cn(
          'inline-flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border border-hairline bg-raised px-2.5 text-sm text-ink hover:bg-wash',
          className,
        )}
      >
        <span className="truncate">
          {selected.length === 0 ? <span className="text-muted">{placeholder}</span> : selected.length <= 2 ? selected.map((s) => s.label).join(', ') : `${selected.length} selected`}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 max-h-80 w-64 overflow-y-auto rounded-md border border-hairline bg-raised p-1 shadow-lg">
          {options.length === 0 && <p className="px-2 py-3 text-sm text-ink-2">{emptyText}</p>}
          {options.map((o) => {
            const checked = value.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => toggle(o.value)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-wash"
                role="menuitemcheckbox"
                aria-checked={checked}
              >
                <span className={cn('flex size-4 items-center justify-center rounded border', checked ? 'border-accent bg-accent text-white' : 'border-axis')}>
                  {checked && <Check className="size-3" strokeWidth={3} />}
                </span>
                {o.color && <span className="size-2.5 shrink-0 rounded-full" style={{ background: o.color }} aria-hidden />}
                <span className="truncate">{o.label}</span>
              </button>
            );
          })}
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="mt-1 w-full rounded px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-wash">
              Clear selection
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export interface MenuOption extends Option {
  /** Second line under the label (e.g. an asset's name and exchange). */
  detail?: string;
}

/** Whether every word of the search appears in the option's value, label or detail (any case). */
function matchesSearch(option: MenuOption, search: string): boolean {
  const text = `${option.value} ${option.label} ${option.detail ?? ''}`.toLowerCase();
  return search.trim().toLowerCase().split(/\s+/).every((word) => text.includes(word));
}

/**
 * Pick one option from a popover list; the trigger shows `children` with a chevron (e.g. the stock panel's ticker).
 * With `searchPlaceholder`, a search box above the list filters it, and Enter picks the first match.
 */
export function MenuSelect({
  options,
  value,
  onChange,
  children,
  label,
  searchPlaceholder,
  footer,
  className,
}: {
  options: MenuOption[];
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  /** Accessible name of the trigger. */
  label: string;
  /** Show a search box with this placeholder above the options. */
  searchPlaceholder?: string;
  footer?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const shown = options.filter((o) => matchesSearch(o, search));
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        // The menu opens with the full list again.
        if (next) setSearch('');
        setOpen(next);
      }}
    >
      <Popover.Trigger aria-label={label} className={cn('inline-flex min-w-0 items-center gap-1 rounded-md text-left hover:bg-wash', className)}>
        {children}
        <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 flex max-h-80 w-72 flex-col rounded-md border border-hairline bg-raised p-1 shadow-lg">
          {searchPlaceholder && (
            <div className="relative mb-1 shrink-0">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && shown[0]) pick(shown[0].value);
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-8 pl-8"
              />
            </div>
          )}
          {/* Only the options scroll: the search box and the footer stay in view. */}
          <div role="menu" aria-label={label} className="min-h-0 overflow-y-auto">
            {shown.map((o) => {
              const selected = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => pick(o.value)}
                  className={cn('flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-wash', selected && 'bg-accent-wash')}
                >
                  <Check className={cn('mt-0.5 size-4 shrink-0', selected ? 'text-accent-strong' : 'invisible')} aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{o.label}</span>
                    {o.detail && <span className="block truncate text-xs text-ink-2">{o.detail}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {shown.length === 0 && <p className="px-2 py-3 text-sm text-ink-2">No matches</p>}
          {footer && <div className="mt-1 shrink-0 border-t border-hairline pt-1">{footer}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
