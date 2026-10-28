import { env } from '../lib/env';
import { errorMessage, logger } from '../lib/logger';
import { listTelegramLinks } from '../repo/telegram';
import { isTelegramConfigured, sendMessage, type SendOptions } from './telegram';

/**
 * Send a message to every Telegram chat and topic the account is connected to. Never throws: a
 * notification failure must not fail the pipeline. True if at least one connection got it.
 */
export async function notifyAccount(sub: string, html: string, opts: SendOptions & { path?: string } = {}): Promise<boolean> {
  try {
    if (!(await isTelegramConfigured())) return false;
    const buttonUrl = opts.buttonUrl ?? `${env.dashboardUrl.replace(/\/$/, '')}${opts.path ?? '/'}`;
    let sent = false;
    for (const link of await listTelegramLinks(sub)) {
      try {
        await sendMessage(link.chatId, html, { buttonText: opts.buttonText, buttonUrl, topicId: link.topicId });
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
