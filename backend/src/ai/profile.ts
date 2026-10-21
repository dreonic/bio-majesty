import { DEFAULT_PROFILE, type Settings } from '@bio-majesty/shared';
import { getAsset } from '../repo/stock';
import type { ProfileContext } from './prompts';

/** The default profile and its asset, for scripts that run without AWS. */
export const DEFAULT_PROFILE_CONTEXT: ProfileContext = {
  profile: DEFAULT_PROFILE,
  asset: { symbol: 'PRDA.JK', name: 'PT Prodia Widyahusada Tbk', type: 'EQUITY' },
};

/** The account's profile and the asset its sentiment is judged against (named by its metadata when known). */
export async function loadProfileContext(settings: Settings): Promise<ProfileContext> {
  const symbol = settings.profile.sentimentSymbol;
  if (!symbol) return { profile: settings.profile, asset: null };
  const asset = await getAsset(symbol);
  return { profile: settings.profile, asset: asset ?? { symbol, name: null, type: null } };
}
