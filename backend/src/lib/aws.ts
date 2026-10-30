import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient, StartExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import type { BackfillPeriod } from '@bio-majesty/shared';
import { env } from './env';
import type { ProfileId } from '../repo/keys';

let sfn: SFNClient | undefined;
let lambda: LambdaClient | undefined;

const stepFunctions = () => (sfn ??= new SFNClient({}));

export async function startExecution(stateMachineArn: string, input: unknown, name?: string): Promise<string> {
  const res = await stepFunctions().send(new StartExecutionCommand({ stateMachineArn, input: JSON.stringify(input), name }));
  return res.executionArn ?? '';
}

/** Start a profile's daily news run now (Settings → Run now; scheduled runs are started by the profile's schedule). */
export function startDailyRun(profileId: ProfileId) {
  return startExecution(env.dailyStateMachineArn, { mode: 'daily', trigger: 'manual', profileId });
}

/** Backfill executions are named after their category, so a cancel can find them (names are unique per state machine). */
const backfillName = (profileId: ProfileId, categoryId: string) => `${profileId}-${categoryId}-`;

export function startBackfillRun(profileId: ProfileId, categoryId: string, period: BackfillPeriod) {
  return startExecution(env.backfillStateMachineArn, { mode: 'backfill', categoryId, period, profileId }, `${backfillName(profileId, categoryId)}${Date.now()}`);
}

/** Stop the category's running backfills (a stopped run skips the pipeline's failure step). Returns how many. */
export async function stopBackfillRuns(profileId: ProfileId, categoryId: string): Promise<number> {
  const prefix = backfillName(profileId, categoryId);
  let stopped = 0;
  let token: string | undefined;
  do {
    const res = await stepFunctions().send(
      new ListExecutionsCommand({ stateMachineArn: env.backfillStateMachineArn, statusFilter: 'RUNNING', maxResults: 100, nextToken: token }),
    );
    for (const execution of res.executions ?? []) {
      if (!execution.name?.startsWith(prefix)) continue;
      await stepFunctions().send(new StopExecutionCommand({ executionArn: execution.executionArn, error: 'Cancelled', cause: 'Cancelled from the dashboard' }));
      stopped++;
    }
    token = res.nextToken;
  } while (token);
  return stopped;
}

/**
 * Stop every running daily or backfill run of the profile (before its data is deleted): the
 * executions whose input names it. Returns how many were stopped.
 */
export async function stopProfileRuns(profileId: ProfileId): Promise<number> {
  let stopped = 0;
  for (const stateMachineArn of [env.dailyStateMachineArn, env.backfillStateMachineArn]) {
    let token: string | undefined;
    do {
      const res = await stepFunctions().send(new ListExecutionsCommand({ stateMachineArn, statusFilter: 'RUNNING', maxResults: 100, nextToken: token }));
      for (const execution of res.executions ?? []) {
        const { input } = await stepFunctions().send(new DescribeExecutionCommand({ executionArn: execution.executionArn }));
        if ((JSON.parse(input ?? '{}') as { profileId?: string }).profileId !== profileId) continue;
        await stepFunctions().send(new StopExecutionCommand({ executionArn: execution.executionArn, error: 'Cancelled', cause: 'The profile was deleted' }));
        stopped++;
      }
      token = res.nextToken;
    } while (token);
  }
  return stopped;
}

export async function invokeAsync(functionName: string, payload: unknown): Promise<void> {
  lambda ??= new LambdaClient({});
  await lambda.send(
    new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: JSON.stringify(payload) }),
  );
}
