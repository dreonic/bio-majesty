import type { Context } from 'aws-lambda';
import { invokeAsync, stopProfileRuns } from '../lib/aws';
import { errorMessage, logger } from '../lib/logger';
import { deleteDailySchedule } from '../lib/schedules';
import { sleep } from '../lib/time';
import { deleteUser } from '../lib/users';
import { asProfileId } from '../repo/keys';
import { deleteProfileData } from '../repo/profile-data';
import { listProfiles, removeAccountProfile } from '../repo/profiles';

export type DeleteEvent =
  /** One profile, already off its account's list, with its schedule deleted and no run in progress. */
  | { profileId: string }
  /** An account, already locked out: each of its profiles, then its Cognito user. */
  | { sub: string; username: string };

/** With less time left than this, an account's remaining profiles go to a fresh invocation. */
const CONTINUE_BELOW_MS = 4 * 60 * 1000;
/** After stopping a profile's runs, steps already running may still write for a little while. */
const AFTER_STOP_MS = 60 * 1000;

/**
 * Deletes a profile's data, or an account's profiles one by one and then its Cognito user.
 * Invoked asynchronously (Settings → Delete profile, the Admin page), so it isn't bound by the
 * API's 29 seconds, and an account with many profiles carries on in a fresh invocation. Lambda
 * retries a failed attempt twice; a deleted user stays listed (disabled) until all of it succeeded.
 */
export async function handler(event: DeleteEvent, context: Pick<Context, 'functionName' | 'getRemainingTimeInMillis'>): Promise<void> {
  const who = 'profileId' in event ? { profileId: event.profileId } : { sub: event.sub };
  try {
    if ('profileId' in event) {
      const deleted = await deleteProfileData(asProfileId(event.profileId));
      logger.info('Deleted profile', { ...who, ...deleted });
      return;
    }
    for (const { id } of await listProfiles(event.sub)) {
      if (context.getRemainingTimeInMillis() < CONTINUE_BELOW_MS) {
        await invokeAsync(context.functionName, event);
        logger.info('Account deletion continues in a new invocation', who);
        return;
      }
      const profileId = asProfileId(id);
      await deleteDailySchedule(profileId);
      if (await stopProfileRuns(profileId)) await sleep(AFTER_STOP_MS);
      const deleted = await deleteProfileData(profileId);
      await removeAccountProfile(event.sub, profileId);
      logger.info('Deleted a profile of a deleted account', { ...who, profileId, ...deleted });
    }
    await deleteUser(event.username);
    logger.info('Deleted account', who);
  } catch (err) {
    logger.error('Deletion failed', { ...who, error: errorMessage(err) });
    throw err;
  }
}
