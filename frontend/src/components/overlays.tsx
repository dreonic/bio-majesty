import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

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
