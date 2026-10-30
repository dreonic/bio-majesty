import type { Settings } from '@bio-majesty/shared';
import { getAsset } from '../repo/stock';
import type { SubjectContext } from './prompts';

/** The profile's subject and the asset its sentiment is judged against (named by its metadata when known). */
export async function loadSubjectContext(settings: Settings): Promise<SubjectContext> {
  const id = settings.subject.sentimentAsset;
  if (!id) return { subject: settings.subject, asset: null };
  const asset = await getAsset(id);
  return { subject: settings.subject, asset: asset ?? { id, name: null, type: null } };
}
