import { env } from '../lib/env';
import { errorMessage, logger } from '../lib/logger';
import { getTelegramLink } from '../repo/telegram';
import { isTelegramConfigured, sendMessage, type SendOptions } from './telegram';

/**
 * Send a message to the account's linked Telegram chat, if any. Never throws: a
 * notification failure must not fail the pipeline.
 */
export async function notifyAccount(sub: string, html: string, opts: SendOptions & { path?: string } = {}): Promise<boolean> {
  try {
    if (!(await isTelegramConfigured())) return false;
    const link = await getTelegramLink(sub);
    if (!link.chatId) return false;
    const buttonUrl = opts.buttonUrl ?? `${env.dashboardUrl.replace(/\/$/, '')}${opts.path ?? '/'}`;
    await sendMessage(link.chatId, html, { buttonText: opts.buttonText, buttonUrl, topicId: link.topicId });
    return true;
  } catch (err) {
    logger.error('Telegram notification failed', { error: errorMessage(err) });
    return false;
  }
}
