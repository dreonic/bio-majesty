import { z } from 'zod';
import { IsoDateTime } from './common';

/**
 * Request header naming the profile a request works on. The API checks that it is one of the
 * signed-in account's profiles; account-level routes (/profiles, /admin) don't need it.
 */
export const PROFILE_HEADER = 'X-Profile-Id';

/** Profile IDs are short random IDs; they also go into Step Functions execution names. */
export const ProfileIdSchema = z.string().regex(/^[a-z0-9]{1,40}$/, 'invalid profile ID');

export const ProfileNameSchema = z.string().trim().min(1, 'Give the profile a name').max(60);

/**
 * One of an account's profiles: a separate desk with its own subject, assets, categories, review
 * queue, saved news, chats, settings and Telegram connections. Whoever signs in to the account can
 * open all of them.
 */
export const ProfileSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: IsoDateTime,
});
export type ProfileSummary = z.infer<typeof ProfileSummarySchema>;

export const ProfileInputSchema = z.object({ name: ProfileNameSchema });
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export interface ProfilesResponse {
  items: ProfileSummary[];
}

/**
 * Minutes after its set time a profile's daily run starts (0–14), fixed per profile: profiles set
 * to the same time don't all hit the news sources and AI providers at once, and each profile's runs
 * stay 24 hours apart, so its daily search window stays one day.
 */
export function dailyRunOffset(profileId: string): number {
  let hash = 0;
  for (const ch of profileId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 15;
}

/** "HH:mm" a profile's daily run starts: its set time plus its offset. */
export function dailyRunStart(dailyTime: string, profileId: string): string {
  const [h = 0, m = 0] = dailyTime.split(':').map(Number);
  const minutes = (h * 60 + m + dailyRunOffset(profileId)) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
