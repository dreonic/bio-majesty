import { Loader2 } from 'lucide-react';
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'good';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong disabled:bg-accent/50',
  secondary: 'bg-raised text-ink border border-hairline hover:bg-wash disabled:text-muted',
  ghost: 'text-ink-2 hover:bg-wash hover:text-ink disabled:text-muted',
  danger: 'bg-raised text-critical border border-hairline hover:bg-critical-wash disabled:opacity-50',
  good: 'bg-good-text text-white hover:bg-good-text/90 disabled:opacity-50',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-sm gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-hairline bg-raised px-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none',
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-md border border-hairline bg-raised px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none',
        className,
      )}
      {...rest}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn('h-9 rounded-md border border-hairline bg-raised px-2.5 text-sm text-ink focus:border-accent focus:outline-none', className)}
      {...rest}
    >
      {children}
    </select>
  );
});

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn('flex w-fit cursor-pointer items-center gap-2 text-sm', disabled && 'cursor-not-allowed opacity-60')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative h-5 w-9 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-axis')}
      >
        <span className={cn('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
      </button>
      <span className="text-ink">{label}</span>
    </label>
  );
}

/** Native checkbox; `indeterminate` shows the "some selected" state of a select-all box. */
export function Checkbox({ indeterminate = false, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" className={cn('size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed', className)} {...rest} />;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-lg border border-hairline bg-raised', className)}>{children}</div>;
}

export function Badge({ className, children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-full border border-hairline bg-surface px-2 py-0.5 text-xs font-medium text-ink-2', className)}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-muted', className)} aria-label="Loading" />;
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="max-w-md text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function SectionTitle({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-5 py-4">
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A card's save (and similar) buttons, at its bottom right. */
export function CardFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-5 py-3">{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-2">{hint}</span>}
    </label>
  );
}
