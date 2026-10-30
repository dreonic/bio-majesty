import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
  type CreateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import { dailyRunStart, type Settings } from '@bio-majesty/shared';
import type { ProfileId } from '../repo/keys';
import { env } from './env';

let client: SchedulerClient | undefined;
const scheduler = () => (client ??= new SchedulerClient({}));

/**
 * The EventBridge Scheduler schedule of a profile's daily run (named after the profile): its set
 * time plus its fixed offset, on the deployment's clock. A failed start is retried for an hour.
 */
export function dailySchedule(profileId: ProfileId, schedule: Settings['schedule']): CreateScheduleCommandInput {
  const [hour, minute] = dailyRunStart(schedule.dailyTime, profileId).split(':').map(Number);
  return {
    Name: profileId,
    GroupName: env.dailyScheduleGroup,
    Description: "A profile's daily news run (its time is in the profile's Settings)",
    ScheduleExpression: `cron(${minute} ${hour} * * ? *)`,
    ScheduleExpressionTimezone: env.timeZone,
    State: schedule.enabled ? 'ENABLED' : 'DISABLED',
    FlexibleTimeWindow: { Mode: 'OFF' },
    Target: {
      Arn: env.dailyStateMachineArn,
      RoleArn: env.schedulerRoleArn,
      Input: JSON.stringify({ mode: 'daily', trigger: 'schedule', profileId }),
      RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 10 },
    },
  };
}

/** Create or update the profile's daily-run schedule (when the profile is created and when its run time changes). */
export async function putDailySchedule(profileId: ProfileId, schedule: Settings['schedule']): Promise<void> {
  const input = dailySchedule(profileId, schedule);
  try {
    await scheduler().send(new UpdateScheduleCommand(input));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
    await scheduler().send(new CreateScheduleCommand(input));
  }
}

/** Delete the profile's daily-run schedule (already gone is fine). */
export async function deleteDailySchedule(profileId: ProfileId): Promise<void> {
  try {
    await scheduler().send(new DeleteScheduleCommand({ Name: profileId, GroupName: env.dailyScheduleGroup }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
}
