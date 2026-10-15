import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetScheduleCommand, SchedulerClient, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { env } from './env';

let sfn: SFNClient | undefined;
let scheduler: SchedulerClient | undefined;
let lambda: LambdaClient | undefined;

export async function startExecution(stateMachineArn: string, input: unknown, name?: string): Promise<string> {
  sfn ??= new SFNClient({});
  const res = await sfn.send(new StartExecutionCommand({ stateMachineArn, input: JSON.stringify(input), name }));
  return res.executionArn ?? '';
}

export function startDailyRun(trigger: 'manual' | 'schedule') {
  return startExecution(env.dailyStateMachineArn, { mode: 'daily', trigger });
}

export function startBackfillRun(categoryId: string, months: number) {
  return startExecution(env.backfillStateMachineArn, { mode: 'backfill', categoryId, months });
}

/** "HH:mm" (the exec's time zone) -> EventBridge Scheduler cron expression. */
export function dailyCron(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `cron(${m} ${h} * * ? *)`;
}

/** Update the daily ingest schedule in place (keeps its target and role). */
export async function updateDailySchedule(hhmm: string, enabled: boolean): Promise<void> {
  scheduler ??= new SchedulerClient({});
  const current = await scheduler.send(
    new GetScheduleCommand({ Name: env.dailyScheduleName, GroupName: env.dailyScheduleGroup }),
  );
  await scheduler.send(
    new UpdateScheduleCommand({
      Name: current.Name,
      GroupName: current.GroupName,
      Description: current.Description,
      ScheduleExpression: dailyCron(hhmm),
      ScheduleExpressionTimezone: env.timeZone,
      FlexibleTimeWindow: current.FlexibleTimeWindow ?? { Mode: 'OFF' },
      Target: current.Target,
      State: enabled ? 'ENABLED' : 'DISABLED',
      StartDate: current.StartDate,
      EndDate: current.EndDate,
      KmsKeyArn: current.KmsKeyArn,
      ActionAfterCompletion: current.ActionAfterCompletion,
    }),
  );
}

export async function invokeAsync(functionName: string, payload: unknown): Promise<void> {
  lambda ??= new LambdaClient({});
  await lambda.send(
    new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: JSON.stringify(payload) }),
  );
}
