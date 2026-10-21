import { errorMessage, logger } from '../lib/logger';
import { formatFailureMessage } from '../notify/telegram';
import { notifyAccount } from '../notify/notify';
import { updateCategory } from '../repo/categories';
import { aggregateRunUsage, finishRun } from '../repo/runs';
import type { FailInput, PipelineState } from './state';

export async function finishRunStep(state: PipelineState): Promise<PipelineState> {
  await aggregateRunUsage(state.sub, state.runId);
  await finishRun(state.sub, state.runId, 'succeeded');
  if (state.runType === 'backfill' && state.categoryId) {
    await updateCategory(state.sub, state.categoryId, (c) => ({
      ...c,
      active: true,
      backfill: { ...c.backfill, status: 'done', completedAt: new Date().toISOString(), error: null },
    }));
  }
  return state;
}

/** Catch-all failure handler: mark the run failed and alert the account. */
export async function failRunStep(input: FailInput): Promise<void> {
  const state = input;
  const message = describeError(input.error);
  logger.error('Pipeline run failed', { runId: state.runId, message });
  const sub = state.sub;
  if (!sub) return; // failed before the run had an account (bad input): nothing to record or notify
  try {
    if (state.runId) {
      await aggregateRunUsage(sub, state.runId).catch(() => undefined);
      await finishRun(sub, state.runId, 'failed', message);
    }
    if (state.runType === 'backfill' && state.categoryId) {
      await updateCategory(sub, state.categoryId, (c) => ({
        ...c,
        // Activate anyway so the daily run still covers this category.
        active: true,
        backfill: { ...c.backfill, status: 'failed', completedAt: new Date().toISOString(), error: message },
      }));
    }
  } catch (err) {
    logger.error('Failed to record run failure', { error: errorMessage(err) });
  }
  await notifyAccount(sub, formatFailureMessage(state.runType === 'backfill' ? 'Backfill' : 'Daily news run', message), {
    buttonText: 'Open settings',
    path: '/settings',
  });
}

function describeError(error: FailInput['error']): string {
  if (!error) return 'Unknown error';
  const cause = error.Cause ?? '';
  try {
    const parsed = JSON.parse(cause) as { errorMessage?: string; errorType?: string };
    if (parsed.errorMessage) return `${error.Error ?? parsed.errorType ?? 'Error'}: ${parsed.errorMessage}`;
  } catch {
    // Cause is not JSON
  }
  return [error.Error, cause].filter(Boolean).join(': ').slice(0, 2000) || 'Unknown error';
}
