import { env } from '../lib/env';
import { errorMessage, logger } from '../lib/logger';
import { getTelegramState } from '../repo/telegram';
import { isTelegramConfigured, sendMessage, type SendOptions } from './telegram';

/**
 * Send a message to the linked Telegram chat, if any. Never throws: a
 * notification failure must not fail the pipeline.
 */
export async function notifyExec(html: string, opts: SendOptions & { path?: string } = {}): Promise<boolean> {
  try {
    if (!(await isTelegramConfigured())) return false;
    const state = await getTelegramState();
    if (!state.chatId) return false;
    const buttonUrl = opts.buttonUrl ?? `${env.dashboardUrl.replace(/\/$/, '')}${opts.path ?? '/'}`;
    await sendMessage(state.chatId, html, { buttonText: opts.buttonText, buttonUrl });
    return true;
  } catch (err) {
    logger.error('Telegram notification failed', { error: errorMessage(err) });
    return false;
  }
}
