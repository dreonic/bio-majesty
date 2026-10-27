import { effectiveRationale, effectiveSummary, effectiveTags, type Article, type Category, type Sentiment } from '@bio-majesty/shared';
import { Check, ExternalLink, Pencil, Undo2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EditableText } from '../../components/EditableText';
import { CategoryChips, SENTIMENT_META, SentimentBadge, SentimentPicker } from '../../components/tags';
import { TagEditor } from '../../components/TagEditor';
import { useToast } from '../../components/toast';
import { Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatDateTime, relativeTime } from '../../lib/format';
import { useReview } from '../../lib/queries';
import { useOpenArticle } from './ArticleSheet';

const SKIPPED = 'Skipped · moved to the recycle bin';

export interface ArticleCardHandle {
  save: () => void;
  skip: () => void;
  details: () => void;
}

/**
 * One article. In the Review tab it is always editable (tags, sentiment,
 * summary, reason) with Save / Skip; in the News tab it is read-only until the
 * reviewer clicks Edit. Edits are sent with the decision and stored as training
 * feedback for the classifier.
 */
export function ArticleCard({
  article,
  categories,
  mode,
  focused = false,
  onFocus,
  handleRef,
}: {
  article: Article;
  categories: Category[];
  mode: 'review' | 'saved';
  focused?: boolean;
  onFocus?: () => void;
  handleRef?: (h: ArticleCardHandle | null) => void;
}) {
  const openArticle = useOpenArticle();
  const review = useReview();
  const toast = useToast();
  const tags = effectiveTags(article);
  const aiSummary = article.suggestion?.summary ?? article.snippet ?? '';
  const aiRationale = article.suggestion?.rationale ?? '';

  const [editingSaved, setEditingSaved] = useState(false);
  const [categoryIds, setCategoryIds] = useState(tags.categoryIds);
  const [sentiment, setSentiment] = useState<Sentiment>(tags.sentiment);
  const [summary, setSummary] = useState(effectiveSummary(article));
  const [rationale, setRationale] = useState(effectiveRationale(article));
  const editing = mode === 'review' || editingSaved;

  const reset = () => {
    setCategoryIds(tags.categoryIds);
    setSentiment(tags.sentiment);
    setSummary(effectiveSummary(article));
    setRationale(effectiveRationale(article));
  };

  // mutateAsync, not mutate(…, callbacks): Save/Skip remove the card at once, and
  // per-call callbacks do not fire once the component has unmounted.
  const send = (action: 'approve' | 'reject' | 'update' | 'unsave', message: string) =>
    review
      .mutateAsync({
        id: article.id,
        action,
        categoryIds,
        sentiment,
        ...(summary.trim() !== aiSummary.trim() ? { summary } : {}),
        ...(rationale.trim() !== aiRationale.trim() ? { rationale } : {}),
      })
      .then(() => {
        toast.success(message);
        setEditingSaved(false);
      }, toast.error);

  useEffect(() => {
    if (!handleRef) return;
    handleRef({ save: () => send('approve', 'Saved'), skip: () => send('reject', SKIPPED), details: () => openArticle(article.id) });
    return () => handleRef(null);
  });

  const sentimentLabel = SENTIMENT_META[sentiment].label.toLowerCase();

  return (
    <article
      onClick={onFocus}
      className={cn('rounded-lg border border-hairline bg-raised p-4 transition-shadow', focused && 'border-accent/40 ring-2 ring-accent/40')}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
            {!editing && <SentimentBadge sentiment={tags.sentiment} />}
            <span className="font-medium text-ink">{article.sourceName ?? article.sourceDomain ?? 'Unknown source'}</span>
            <span aria-hidden>·</span>
            <time dateTime={article.publishedAt} title={formatDateTime(article.publishedAt)}>
              {relativeTime(article.publishedAt)}
            </time>
          </div>
          <h3 className="text-[15px] leading-snug font-semibold text-ink">
            <button className="text-left hover:underline" onClick={() => openArticle(article.id)}>
              {article.title}
            </button>
          </h3>

          {editing ? (
            <EditableText value={summary} original={aiSummary} onChange={setSummary} label="Summary" className="text-sm leading-relaxed text-ink-2" />
          ) : (
            summary && <p className="line-clamp-3 text-sm leading-relaxed text-ink-2">{summary}</p>
          )}

          {editing ? <TagEditor value={categoryIds} onChange={setCategoryIds} categories={categories} /> : <CategoryChips ids={tags.categoryIds} categories={categories} />}

          {editing && (aiRationale || rationale) && (
            <div className="rounded-md bg-wash px-3 py-2 text-sm text-ink">
              <EditableText
                value={rationale}
                original={aiRationale}
                onChange={setRationale}
                label="Reason"
                maxLength={1000}
                prefix={<span className="font-medium">Why {sentimentLabel}: </span>}
              />
              {article.suggestion && mode === 'review' && (
                <p className="mt-1 text-xs text-ink-2">AI confidence {Math.round(article.suggestion.confidence * 100)}%</p>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <a
            href={article.url}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-md p-1.5 text-muted hover:bg-wash hover:text-ink"
            aria-label="Open the original article"
            title="Open the original article"
          >
            <ExternalLink className="size-4" />
          </a>
          {mode === 'saved' && !editingSaved && (
            <button onClick={() => setEditingSaved(true)} className="rounded-md p-1.5 text-muted hover:bg-wash hover:text-ink" aria-label="Edit tags and summary" title="Edit">
              <Pencil className="size-4" />
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
          <SentimentPicker value={sentiment} onChange={setSentiment} size="sm" />
          <div className="ml-auto flex items-center gap-2">
            {mode === 'review' ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => send('reject', SKIPPED)} disabled={review.isPending} icon={<X className="size-4" />}>
                  Skip
                </Button>
                <Button size="sm" variant="good" onClick={() => send('approve', 'Saved')} loading={review.isPending} icon={<Check className="size-4" />}>
                  Save
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => send('unsave', 'Moved back to the review queue')} disabled={review.isPending}>
                  Un-save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    reset();
                    setEditingSaved(false);
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" variant="primary" onClick={() => send('update', 'Changes saved')} loading={review.isPending} icon={<Check className="size-4" />}>
                  Save changes
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
