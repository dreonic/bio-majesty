import type { Digest } from '@bio-majesty/shared';
import { digestCounts, writeDigest } from '../ai/tasks/digest';
import { UsageCollector } from '../ai/usage';
import { errorMessage, logger } from '../lib/logger';
import { localDate } from '../lib/time';
import { formatDigestMessage, escapeHtml } from '../notify/telegram';
import { notifyExec } from '../notify/notify';
import { batchGetArticles, listRunItems } from '../repo/articles';
import { getCategory, listCategories } from '../repo/categories';
import { putDigest } from '../repo/digests';
import { recordRunUsage } from '../repo/runs';
import { getSettings } from '../repo/settings';
import type { PipelineState } from './state';

/** Summarize what the run found, store the digest, and notify the exec on Telegram. */
export async function digestRun(state: PipelineState): Promise<PipelineState> {
  const ids = await listRunItems(state.runId);
  const articles = (await batchGetArticles(ids)).filter((a) => a.status === 'PENDING');
  const [categories, settings] = await Promise.all([listCategories(), getSettings()]);
  const category = state.categoryId ? await getCategory(state.categoryId) : null;

  if (!articles.length) {
    if (state.runType === 'backfill') {
      await notifyExec(`🔎 Backfill for <b>${escapeHtml(category?.name ?? 'category')}</b> finished: no new items to review.`);
    } else if (settings.notifications.notifyWhenEmpty) {
      await notifyExec('📰 Daily news run finished: no new items today.');
    }
    return { ...state, pending: 0 };
  }

  const usage = new UsageCollector();
  const counts = digestCounts(articles);
  let content: Pick<Digest, 'title' | 'summary' | 'highlights'>;
  try {
    content = await writeDigest(
      articles,
      categories,
      { runType: state.runType, categoryName: category?.name },
      settings.models.digest,
      usage,
    );
  } catch (err) {
    logger.error('Digest generation failed; using a plain summary', { error: errorMessage(err) });
    content = {
      title: `${counts.total} new item${counts.total === 1 ? '' : 's'} to review`,
      summary: `${counts.positive} positive, ${counts.negative} negative and ${counts.undecided} undecided.`,
      highlights: [],
    };
  }
  await recordRunUsage(state.runId, usage.toEntries());

  const digest: Digest = {
    id: state.runType === 'backfill' ? `${localDate()}-backfill-${state.runId}` : localDate(),
    runId: state.runId,
    runType: state.runType,
    title: state.runType === 'backfill' && category ? `Backfill · ${category.name}: ${content.title}` : content.title,
    summary: content.summary,
    highlights: content.highlights,
    counts,
    createdAt: new Date().toISOString(),
  };
  await putDigest(digest);
  await notifyExec(formatDigestMessage(digest), { buttonText: 'Open review queue', path: '/?tab=review' });
  return { ...state, pending: articles.length };
}
