import type { Category, Sentiment } from '@bio-majesty/shared';
import { CircleHelp, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Sentiment uses the reserved status colors and is never color-only: every
 * badge carries an icon and a text label (text stays in ink tokens).
 */
export const SENTIMENT_META: Record<Sentiment, { label: string; hint: string; color: string; wash: string; Icon: typeof TrendingUp }> = {
  positive: { label: 'Positive', hint: "Likely good news for your profile's subject or asset", color: 'var(--color-good)', wash: 'var(--color-good-wash)', Icon: TrendingUp },
  negative: { label: 'Negative', hint: "Likely bad news for your profile's subject or asset", color: 'var(--color-critical)', wash: 'var(--color-critical-wash)', Icon: TrendingDown },
  neutral: { label: 'Neutral', hint: 'Relevant, but unlikely to matter either way', color: 'var(--color-neutral)', wash: 'var(--color-wash)', Icon: Minus },
  undecided: { label: 'Undecided', hint: 'Could matter, direction unclear', color: 'var(--color-warning)', wash: 'var(--color-warning-wash)', Icon: CircleHelp },
};

export function SentimentBadge({ sentiment, className }: { sentiment: Sentiment; className?: string }) {
  const meta = SENTIMENT_META[sentiment];
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-ink', className)}
      style={{ background: meta.wash }}
      title={meta.hint}
    >
      <meta.Icon className="size-3.5" style={{ color: meta.color }} aria-hidden strokeWidth={2.5} />
      {meta.label}
    </span>
  );
}

export function SentimentPicker({ value, onChange, size = 'md' }: { value: Sentiment; onChange: (s: Sentiment) => void; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex rounded-md border border-hairline bg-surface p-0.5" role="radiogroup" aria-label="Sentiment">
      {(Object.keys(SENTIMENT_META) as Sentiment[]).map((s) => {
        const meta = SENTIMENT_META[s];
        const active = value === s;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={active}
            title={meta.hint}
            onClick={() => onChange(s)}
            className={cn(
              'inline-flex items-center gap-1 rounded px-2 font-medium transition-colors',
              size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
              active ? 'bg-raised text-ink shadow-sm ring-1 ring-hairline' : 'text-ink-2 hover:text-ink',
            )}
          >
            <meta.Icon className="size-3.5" style={{ color: meta.color }} aria-hidden strokeWidth={2.5} />
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}

/** Category tag: colored identity dot + label in ink (never colored text). */
export function CategoryChip({ category, className }: { category: Pick<Category, 'name' | 'color'>; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-2 py-0.5 text-xs text-ink', className)}>
      <span className="size-2 shrink-0 rounded-full" style={{ background: category.color }} aria-hidden />
      {category.name}
    </span>
  );
}

export function CategoryChips({ ids, categories }: { ids: string[]; categories: Category[] }) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const known = ids.map((id) => byId.get(id)).filter((c): c is Category => Boolean(c));
  if (!known.length) return <span className="text-xs text-muted">Uncategorised</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {known.map((c) => (
        <CategoryChip key={c.id} category={c} />
      ))}
    </span>
  );
}
