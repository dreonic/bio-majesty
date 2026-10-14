import { ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { SentimentBadge } from '../../components/tags';
import { Button } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useStoredState } from '../../lib/hooks';
import { useCounts, useDigest } from '../../lib/queries';
import { useOpenArticle } from '../news/ArticleSheet';

/** Latest digest (daily run or backfill); dismissible per digest. */
export function DigestBanner({ onReview }: { onReview: () => void }) {
  const digest = useDigest().data?.digest;
  const pending = useCounts().data?.pending ?? 0;
  const [dismissed, setDismissed] = useStoredState<string | null>('bm:digest-dismissed', null);
  const [expanded, setExpanded] = useState(false);
  const openArticle = useOpenArticle();

  if (!digest || dismissed === `${digest.id}@${digest.createdAt}`) return null;
  const c = digest.counts;

  return (
    <section className="shrink-0 border-b border-hairline bg-accent-wash px-4 py-3" aria-label="Latest digest">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-accent-strong" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="font-semibold text-ink">{digest.title}</h2>
            <span className="text-xs text-ink-2">
              {formatDateTime(digest.createdAt)} · {c.positive} positive · {c.negative} negative · {c.neutral} neutral · {c.undecided} undecided
            </span>
          </div>
          <p className={expanded ? 'mt-1 text-sm text-ink' : 'mt-1 line-clamp-1 text-sm text-ink'}>{digest.summary}</p>
          {expanded && digest.highlights.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {digest.highlights.map((h) => (
                <li key={h.articleId} className="flex items-start gap-2 text-sm">
                  <SentimentBadge sentiment={h.sentiment} className="shrink-0" />
                  <button className="text-left text-ink hover:underline" onClick={() => openArticle(h.articleId)}>
                    <span className="font-medium">{h.title}</span>
                    <span className="text-ink-2"> — {h.why}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {pending > 0 && (
            <Button size="sm" variant="primary" onClick={onReview}>
              Review {pending}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Collapse digest' : 'Expand digest'}>
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(`${digest.id}@${digest.createdAt}`)} aria-label="Dismiss digest">
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}
