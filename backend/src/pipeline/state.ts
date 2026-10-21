import type { SearchTask } from '../sources/types';

/** Payload passed between Step Functions states (kept small; bulk data lives in S3). */
export interface PipelineState {
  /** The account whose run this is: every read and write uses its data. */
  sub: string;
  runId: string;
  runType: 'daily' | 'backfill';
  categoryId: string | null;
  tasks?: SearchTask[];
  candidateCount?: number;
  relevantCount?: number;
  /** S3 key of the JSON array read by the enrich Distributed Map. */
  relevantKey?: string;
  pending?: number;
}

export interface EnrichInput {
  sub: string;
  runId: string;
  runType: 'daily' | 'backfill';
  categoryId: string | null;
  candidateId: string;
}

/** State as seen by the Catch handler: the failing state's input plus `error` (ResultPath "$.error"). */
export type FailInput = Partial<PipelineState> & {
  error?: { Error?: string; Cause?: string };
};
