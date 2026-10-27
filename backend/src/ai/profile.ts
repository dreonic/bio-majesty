import type { Settings } from '@bio-majesty/shared';
import { getAsset } from '../repo/stock';
import type { ProfileContext } from './prompts';

/** The account's profile and the asset its sentiment is judged against (named by its metadata when known). */
export async function loadProfileContext(settings: Settings): Promise<ProfileContext> {
  const id = settings.profile.sentimentAsset;
  if (!id) return { profile: settings.profile, asset: null };
  const asset = await getAsset(id);
  return { profile: settings.profile, asset: asset ?? { id, name: null, type: null } };
}
