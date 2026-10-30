import { env } from '../lib/env';
import { errorMessage, logger } from '../lib/logger';
import type { ProfileId } from '../repo/keys';
import { getProfileRecord } from '../repo/profiles';
import { listTelegramLinks } from '../repo/telegram';
import { escapeHtml, isTelegramConfigured, sendMessage, type SendOptions } from './telegram';

/** The dashboard page `path` (e.g. "/?tab=review"), opened on the profile. */
export function dashboardLink(profileId: ProfileId, path = '/'): string {
  const url = new URL(path, env.dashboardUrl);
  url.searchParams.set('profile', profileId);
  return url.toString();
}

/**
 * Send a message to every Telegram chat and topic the profile is connected to, headed by the
 * profile's name (several profiles may post to one group), with a button that opens the dashboard
 * on the profile. Never throws: a notification failure must not fail the pipeline. True if at
 * least one connection got it.
 */
export async function notifyProfile(profileId: ProfileId, html: string, opts: SendOptions & { path?: string } = {}): Promise<boolean> {
  try {
    if (!(await isTelegramConfigured())) return false;
    const links = await listTelegramLinks(profileId);
    if (!links.length) return false;
    const profile = await getProfileRecord(profileId);
    const text = profile ? `<b>${escapeHtml(profile.name)}</b>\n${html}` : html;
    const buttonUrl = opts.buttonUrl ?? dashboardLink(profileId, opts.path);
    let sent = false;
    for (const link of links) {
      try {
        await sendMessage(link.chatId, text, { buttonText: opts.buttonText, buttonUrl, topicId: link.topicId });
        sent = true;
      } catch (err) {
        // One chat that removed the bot (or a closed topic) must not keep the others from getting it.
        logger.error('Telegram notification failed', { connection: link.id, error: errorMessage(err) });
      }
    }
    return sent;
  } catch (err) {
    logger.error('Telegram notification failed', { error: errorMessage(err) });
    return false;
  }
}
