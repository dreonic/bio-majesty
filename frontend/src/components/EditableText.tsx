import { Pencil, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button, Textarea } from './ui';

/**
 * Text the reviewer can correct in place (summary, reason). Shows an "Edited"
 * marker and a reset link when it differs from the AI's original.
 */
export function EditableText({
  value,
  original,
  onChange,
  label,
  prefix,
  className,
  maxLength = 2000,
}: {
  value: string;
  original: string;
  onChange: (v: string) => void;
  label: string;
  prefix?: ReactNode;
  className?: string;
  maxLength?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const edited = value.trim() !== original.trim();

  // Focus the textarea (cursor at the end) when entering edit mode.
  useEffect(() => {
    if (!editing || !ref.current) return;
    const el = ref.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  if (editing) {
    const commit = () => {
      onChange(draft.trim() || original);
      setEditing(false);
    };
    return (
      <div className={cn('space-y-1.5', className)}>
        <Textarea
          ref={ref}
          value={draft}
          maxLength={maxLength}
          rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 90)))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
          }}
          aria-label={label}
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={commit}>
            Done
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <span className="text-xs text-muted">Ctrl+Enter to finish · Esc to cancel</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('group flex items-start gap-1.5', className)}>
      <p
        className="min-w-0 flex-1 cursor-text"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {prefix}
        {value || <span className="text-muted">No text</span>}
        {edited && <span className="ml-1.5 rounded bg-accent-wash px-1 py-px text-[11px] font-medium text-accent-strong">Edited</span>}
      </p>
      <div className="flex shrink-0 items-center opacity-60 group-hover:opacity-100">
        {edited && (
          <button type="button" onClick={() => onChange(original)} className="rounded p-1 text-muted hover:bg-wash hover:text-ink" title="Restore the AI's text" aria-label={`Restore the AI's ${label.toLowerCase()}`}>
            <RotateCcw className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className="rounded p-1 text-muted hover:bg-wash hover:text-ink"
          aria-label={`Edit ${label.toLowerCase()}`}
          title={`Edit ${label.toLowerCase()}`}
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
