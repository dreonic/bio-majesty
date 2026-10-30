import { PROFILE_HEADER, ProfileIdSchema } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { getAccountProfile } from '../repo/profiles';
import { asProfileId } from '../repo/keys';
import { badRequest, notFound, type AuthUser, type ProfileUser } from './http';

/**
 * The profile a request works on: the one its X-Profile-Id header names, if it is one of the
 * signed-in account's own. Another account's profile gets the same 404 as a missing one.
 */
export async function resolveProfile(event: Pick<APIGatewayProxyEvent, 'headers'>, user: AuthUser): Promise<ProfileUser> {
  const wanted = PROFILE_HEADER.toLowerCase();
  const raw = Object.entries(event.headers ?? {}).find(([name]) => name.toLowerCase() === wanted)?.[1];
  if (!raw) throw badRequest(`Pick a profile first (no ${PROFILE_HEADER} header)`);
  const id = ProfileIdSchema.safeParse(raw);
  if (!id.success || !(await getAccountProfile(user.sub, id.data))) throw notFound('Profile not found');
  return { ...user, profileId: asProfileId(id.data) };
}
