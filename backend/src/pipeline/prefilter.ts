import { prefilterHeadlines } from '../ai/tasks/prefilter';
import { UsageCollector } from '../ai/usage';
import { createArticle } from '../repo/articles';
import { listCategories } from '../repo/categories';
import { addRunStats, recordRunUsage } from '../repo/runs';
import { getSettings } from '../repo/settings';
import { getJson, putJson, s3Keys } from '../storage/s3';
import type { MergedCandidate } from '../sources/types';
import { articleFromCandidate } from './article-factory';
import { candidateAliases } from './collect';
import type { PipelineState } from './state';

/**
 * Screen headlines with the LLM. Irrelevant ones are stored as FILTERED (so
 * later runs drop them, and they can be restored for 30 days); relevant ones are
 * written as individual S3 items for the enrich Distributed Map.
 */
export async function prefilterRun(state: PipelineState): Promise<PipelineState> {
  const candidates = (await getJson<MergedCandidate[]>(s3Keys.candidates(state.runId))) ?? [];
  const relevantKey = s3Keys.relevant(state.runId);
  if (!candidates.length) {
    await putJson(relevantKey, []);
    return { ...state, relevantCount: 0, relevantKey };
  }

  const [categories, settings] = await Promise.all([listCategories(state.sub), getSettings(state.sub)]);
  const exclude = [...new Set(categories.flatMap((c) => c.search.exclude))];
  const usage = new UsageCollector();
  const decisions = await prefilterHeadlines(
    candidates.map((c, i) => ({ i, title: c.title, source: c.sourceName, publishedAt: c.publishedAt, snippet: c.snippet })),
    categories,
    exclude,
    settings.models.prefilter,
    settings.subject,
    usage,
  );

  const relevant: { id: string }[] = [];
  let filtered = 0;
  for (const d of decisions) {
    const c = candidates[d.i];
    if (!c) continue;
    if (d.relevant) {
      if (d.categoryIds.length) c.categoryHints = [...new Set([...d.categoryIds, ...c.categoryHints])];
      await putJson(s3Keys.relevantItem(state.runId, c.id), c);
      relevant.push({ id: c.id });
    } else {
      const article = articleFromCandidate(c, {
        status: 'FILTERED',
        runId: state.runId,
        runType: state.runType,
        categoryId: state.categoryId,
        filterReason: d.reason || 'not relevant',
      });
      if (await createArticle(state.sub, article, candidateAliases(c))) filtered++;
    }
  }

  await putJson(relevantKey, relevant);
  await addRunStats(state.sub, state.runId, { filtered });
  await recordRunUsage(state.runId, usage.toEntries());
  return { ...state, relevantCount: relevant.length, relevantKey };
}
