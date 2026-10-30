import type { BackfillPeriod } from '@bio-majesty/shared';
import type { Context } from 'aws-lambda';
import { collectCandidates } from '../pipeline/collect';
import { digestRun } from '../pipeline/digest';
import { enrichCandidate } from '../pipeline/enrich';
import { failRunStep, finishRunStep } from '../pipeline/finish';
import { prefilterRun } from '../pipeline/prefilter';
import { executeSearchTask } from '../pipeline/search';
import { startBackfill, startDaily } from '../pipeline/start';
import type { EnrichInput, FailInput, PipelineState } from '../pipeline/state';
import type { SearchTask } from '../sources/types';
import { asProfileId, type ProfileId } from '../repo/keys';

/**
 * Step Functions task handlers. Each receives the state object and returns
 * the next one (see lib/constructs/pipeline.ts for the state machines). Every
 * run belongs to one profile (`profileId`).
 */

export async function start(event: {
  mode?: 'daily' | 'backfill';
  trigger?: 'schedule' | 'manual';
  profileId?: string;
  categoryId?: string;
  period?: BackfillPeriod;
}): Promise<PipelineState> {
  if (!event.profileId) throw new Error('A run needs the profile (profileId) it belongs to');
  const profileId = asProfileId(event.profileId);
  if (event.mode === 'backfill') {
    if (!event.categoryId || !event.period) throw new Error('Backfill requires categoryId and period');
    return startBackfill(profileId, event.categoryId, event.period);
  }
  return startDaily(profileId, event.trigger ?? 'schedule');
}

export async function search(event: { profileId: ProfileId; runId: string; task: SearchTask }, context: Context) {
  const deadline = Date.now() + context.getRemainingTimeInMillis() - 20_000;
  return executeSearchTask(event.profileId, event.runId, event.task, deadline);
}

export const collect = (state: PipelineState) => collectCandidates(state);
export const prefilter = (state: PipelineState) => prefilterRun(state);
export const enrich = (input: EnrichInput) => enrichCandidate(input);
export const digest = (state: PipelineState) => digestRun(state);
export const finish = (state: PipelineState) => finishRunStep(state);
export const fail = (input: FailInput) => failRunStep(input);
