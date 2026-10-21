import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { env } from './env';

let sfn: SFNClient | undefined;
let lambda: LambdaClient | undefined;

export async function startExecution(stateMachineArn: string, input: unknown, name?: string): Promise<string> {
  sfn ??= new SFNClient({});
  const res = await sfn.send(new StartExecutionCommand({ stateMachineArn, input: JSON.stringify(input), name }));
  return res.executionArn ?? '';
}

/** Start an account's daily news run. A scheduled start passes a name per time slot, so a repeated tick can't start it twice. */
export function startDailyRun(sub: string, trigger: 'manual' | 'schedule', name?: string) {
  return startExecution(env.dailyStateMachineArn, { mode: 'daily', trigger, sub }, name);
}

export function startBackfillRun(sub: string, categoryId: string, months: number) {
  return startExecution(env.backfillStateMachineArn, { mode: 'backfill', categoryId, months, sub });
}

export async function invokeAsync(functionName: string, payload: unknown): Promise<void> {
  lambda ??= new LambdaClient({});
  await lambda.send(
    new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: JSON.stringify(payload) }),
  );
}
