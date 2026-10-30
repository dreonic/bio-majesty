import { DEFAULT_SETTINGS, ProfileInputSchema, type ProfilesResponse } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { invokeAsync } from '../../lib/aws';
import { env } from '../../lib/env';
import { badRequest, conflict, json, notFound, parseBody, pathParam, type AuthUser } from '../../lib/http';
import { createRouter } from '../../lib/router';
import { deleteDailySchedule, putDailySchedule } from '../../lib/schedules';
import { asProfileId, type ProfileId } from '../../repo/keys';
import { deleteProfileData } from '../../repo/profile-data';
import { createProfile, getAccountProfile, listProfiles, removeAccountProfile, renameProfile } from '../../repo/profiles';
import { listRuns } from '../../repo/runs';
import type { DeleteEvent } from '../delete-worker';

/** A run older than this is treated as stuck, not in progress. */
const RUN_IN_PROGRESS_MS = 6 * 60 * 60 * 1000;

/** The path's profile, if it is one of the caller's (another account's profile looks like a missing one). */
async function ownProfile(event: APIGatewayProxyEvent, user: AuthUser): Promise<ProfileId> {
  const id = pathParam(event, 'id');
  if (!(await getAccountProfile(user.sub, id))) throw notFound('Profile not found');
  return asProfileId(id);
}

/** The signed-in account's profiles (account-level: no X-Profile-Id header). */
export const handler = createRouter({
  'GET /profiles': async (_event, user) => {
    const body: ProfilesResponse = { items: await listProfiles(user.sub) };
    return json(200, body);
  },

  /** A new, blank profile. Its daily run is scheduled at the default time and starts searching once it has a category. */
  'POST /profiles': async (event, user) => {
    const { name } = parseBody(event, ProfileInputSchema);
    const profile = await createProfile(user.sub, name);
    const id = asProfileId(profile.id);
    try {
      await putDailySchedule(id, DEFAULT_SETTINGS.schedule);
    } catch (err) {
      // A profile without its schedule would never run: take it back.
      await removeAccountProfile(user.sub, id);
      await deleteProfileData(id);
      throw err;
    }
    return json(201, profile);
  },

  'PATCH /profiles/{id}': async (event, user) => {
    const id = await ownProfile(event, user);
    const { name } = parseBody(event, ProfileInputSchema);
    await renameProfile(user.sub, id, name);
    return json(200, await getAccountProfile(user.sub, id));
  },

  /** Takes the profile off the account at once (no more access or runs); the worker deletes its data. */
  'DELETE /profiles/{id}': async (event, user) => {
    const id = await ownProfile(event, user);
    if ((await listProfiles(user.sub)).length <= 1) throw badRequest('This is your only profile. Add another one before deleting it.');
    // A run in flight would write news back into the deleted partition.
    const runs = await listRuns(id, 5);
    if (runs.some((r) => r.status === 'running' && Date.now() - Date.parse(r.startedAt) < RUN_IN_PROGRESS_MS)) {
      throw conflict('A news run is in progress for this profile. Try again when it has finished (usually within minutes; a backfill can be cancelled in Settings → Categories).');
    }
    await deleteDailySchedule(id);
    await removeAccountProfile(user.sub, id);
    const payload: DeleteEvent = { profileId: id };
    await invokeAsync(env.deleteWorkerFunction, payload);
    return json(202, { deleting: true });
  },
});
