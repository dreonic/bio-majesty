import type { ArticleDetail } from '@bio-majesty/shared';
import { ExternalLink, RotateCcw } from 'lucide-react';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Sheet } from '../../components/overlays';
import { useToast } from '../../components/toast';
import { Badge, Button, Spinner } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useArticle, useReview } from '../../lib/queries';

const OpenArticleContext = createContext<(id: string) => void>(() => undefined);

/** Lets any component (news list, chart markers, chat sources, digest) open an article. */
export function ArticleSheetProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<string | null>(null);
  return (
    <OpenArticleContext.Provider value={setId}>
      {children}
      <ArticleSheet id={id} onClose={() => setId(null)} />
    </OpenArticleContext.Provider>
  );
}

export function useOpenArticle() {
  return useContext(OpenArticleContext);
}

function ArticleSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: article, isLoading } = useArticle(id);
  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()} title={article?.title ?? 'Article'} description={article ? `${article.sourceName ?? article.sourceDomain ?? 'Unknown source'} · ${formatDateTime(article.publishedAt)}` : undefined}>
      {isLoading || !article ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <ArticleBody key={article.id} article={article} onDone={onClose} />
      )}
    </Sheet>
  );
}

/**
 * Side panel: the original source and the extracted text. Tags, sentiment,
 * summary and reason are edited on the card itself.
 */
function ArticleBody({ article, onDone }: { article: ArticleDetail; onDone: () => void }) {
  const review = useReview();
  const toast = useToast();
  const [showText, setShowText] = useState(false);
  const restorable = article.status === 'REJECTED' || article.status === 'FILTERED';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href={article.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm font-medium text-accent-strong hover:underline">
          Open source <ExternalLink className="size-3.5" aria-hidden />
        </a>
        {restorable && <Badge>{article.status === 'FILTERED' ? 'Filtered by AI' : 'Skipped'}</Badge>}
      </div>

      {article.text ? (
        <section className="space-y-2">
          <button className="text-sm font-medium text-accent-strong hover:underline" onClick={() => setShowText(!showText)}>
            {showText ? 'Hide extracted text' : 'Show extracted text'}
          </button>
          {showText && (
            <div className="rounded-md border border-hairline bg-surface p-3 text-sm leading-relaxed whitespace-pre-line text-ink">{article.text}</div>
          )}
        </section>
      ) : (
        <p className="text-sm text-ink-2">The full text could not be extracted (paywall or blocked page). Open the source to read it.</p>
      )}

      {restorable && (
        <Button
          icon={<RotateCcw className="size-4" />}
          loading={review.isPending}
          onClick={() =>
            review.mutate(
              { id: article.id, action: 'restore' },
              {
                onSuccess: () => {
                  toast.success('Restored to the review queue');
                  onDone();
                },
                onError: toast.error,
              },
            )
          }
        >
          Restore to review
        </Button>
      )}
    </div>
  );
}
