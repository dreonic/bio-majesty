import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ListExecutionsCommand, SFNClient, StartExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import type { BackfillPeriod } from '@bio-majesty/shared';
import { env } from './env';

let sfn: SFNClient | undefined;
let lambda: LambdaClient | undefined;

const stepFunctions = () => (sfn ??= new SFNClient({}));

export async function startExecution(stateMachineArn: string, input: unknown, name?: string): Promise<string> {
  const res = await stepFunctions().send(new StartExecutionCommand({ stateMachineArn, input: JSON.stringify(input), name }));
  return res.executionArn ?? '';
}

/** Start an account's daily news run. A scheduled start passes a name per time slot, so a repeated tick can't start it twice. */
export function startDailyRun(sub: string, trigger: 'manual' | 'schedule', name?: string) {
  return startExecution(env.dailyStateMachineArn, { mode: 'daily', trigger, sub }, name);
}

/** Backfill executions are named after their category, so a cancel can find them (names are unique per state machine). */
const backfillName = (sub: string, categoryId: string) => `${sub}-${categoryId}-`;

export function startBackfillRun(sub: string, categoryId: string, period: BackfillPeriod) {
  return startExecution(env.backfillStateMachineArn, { mode: 'backfill', categoryId, period, sub }, `${backfillName(sub, categoryId)}${Date.now()}`);
}

/** Stop the category's running backfills (a stopped run skips the pipeline's failure step). Returns how many. */
export async function stopBackfillRuns(sub: string, categoryId: string): Promise<number> {
  const prefix = backfillName(sub, categoryId);
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

export async function invokeAsync(functionName: string, payload: unknown): Promise<void> {
  lambda ??= new LambdaClient({});
  await lambda.send(
    new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: JSON.stringify(payload) }),
  );
}
