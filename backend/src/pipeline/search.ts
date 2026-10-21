import { errorMessage, logger } from '../lib/logger';
import { addRunStats } from '../repo/runs';
import { putJson, s3Keys } from '../storage/s3';
import { searchGdeltSequential } from '../sources/gdelt';
import { searchGoogleNews } from '../sources/google-news-rss';
import { jitter } from '../sources/http-fetch';
import type { RawCandidate, SearchTask } from '../sources/types';

/** Execute one search task and store the raw hits in S3. */
export async function executeSearchTask(
  sub: string,
  runId: string,
  task: SearchTask,
  deadline: number,
): Promise<{ taskId: string; count: number; errors: number }> {
  const from = new Date(task.from);
  const to = new Date(task.to);
  let candidates: RawCandidate[] = [];
  let errors = 0;

  if (task.provider === 'gnews') {
    for (const q of task.queries) {
      await jitter(500, 2_000); // be gentle with an unofficial endpoint
      try {
        candidates.push(
          ...(await searchGoogleNews({ q: q.q, lang: q.lang, exclude: q.exclude, from, to, mode: task.mode, categoryId: q.categoryId })),
        );
      } catch (err) {
        errors++;
        logger.warn('Google News search failed', { q: q.q, error: errorMessage(err) });
      }
    }
  } else {
    const result = await searchGdeltSequential(task.queries, from, to, deadline);
    candidates = result.candidates;
    errors += result.errors;
  }

  // Drop hits outside the window (Google's relative operators are approximate).
  const lower = from.getTime() - 36 * 3600 * 1000;
  candidates = candidates.filter((c) => !c.publishedAt || new Date(c.publishedAt).getTime() >= lower);

  await putJson(s3Keys.rawResults(runId, task.id), candidates);
  await addRunStats(sub, runId, { searched: task.queries.length, errors });
  return { taskId: task.id, count: candidates.length, errors };
}
