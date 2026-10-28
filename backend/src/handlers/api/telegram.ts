import { TelegramLinkVerifyRequestSchema, type TelegramLinkStartResponse } from '@bio-majesty/shared';
import { badRequest, json, noContent, parseBody } from '../../lib/http';
import { randomId } from '../../lib/ids';
import { createRouter } from '../../lib/router';
import { getBotUsername, getUpdates, isTelegramConfigured, messageDestination, sendMessage, type TelegramUpdate } from '../../notify/telegram';
import {
  getLinkCode,
  getTelegramLink,
  getUpdateOffset,
  markLinkCodeUsed,
  putLinkCode,
  putTelegramLink,
  setUpdateOffset,
  UNLINKED,
} from '../../repo/telegram';

const LINK_TTL_MS = 10 * 60 * 1000;

async function requireConfigured(): Promise<void> {
  if (!(await isTelegramConfigured())) {
    throw badRequest('Telegram is not configured. Add TELEGRAM_BOT_TOKEN to the API keys parameter (see README).');
  }
}

/**
 * "/start <code>" messages in a batch of updates: from a private chat, or "/start@<bot> <code>" from a
 * group or one of its topics (commands for other bots are skipped).
 */
export function startCodes(updates: TelegramUpdate[], botUsername: string): { code: string; update: TelegramUpdate }[] {
  return updates.flatMap((update) => {
    const m = /^\/start(?:@(\w+))?\s+(\S+)$/.exec(update.message?.text?.trim() ?? '');
    if (!m || !update.message || (m[1] && m[1].toLowerCase() !== botUsername.toLowerCase())) return [];
    return [{ code: m[2]!, update }];
  });
}

/**
 * Link every account whose /start message is in the batch, not just the caller's: the bot has one
 * update offset, so a message read here is never returned to another account's check.
 */
async function linkStarted(updates: TelegramUpdate[]): Promise<void> {
  for (const { code, update } of startCodes(updates, await getBotUsername())) {
    const link = await getLinkCode(code);
    if (!link || link.linkedChatTitle) continue;
    const message = update.message!;
    const { topicId, title } = messageDestination(message);
    await putTelegramLink(link.sub, { chatId: message.chat.id, topicId, chatTitle: title, linkedAt: new Date().toISOString() });
    await markLinkCodeUsed(code, title);
    await sendMessage(message.chat.id, '✅ Connected. You will receive news digests and alerts here.', { topicId });
  }
}

export const handler = createRouter({
  'POST /telegram/link': async (_event, user) => {
    await requireConfigured();
    const code = randomId(24);
    await putLinkCode(code, user.sub);
    const bot = await getBotUsername();
    const body: TelegramLinkStartResponse = {
      code,
      deepLink: `https://t.me/${bot}?start=${code}`,
      groupCommand: `/start@${bot} ${code}`,
      expiresAt: new Date(Date.now() + LINK_TTL_MS).toISOString(),
    };
    return json(200, body);
  },

  'POST /telegram/link/verify': async (event, user) => {
    await requireConfigured();
    const { code } = parseBody(event, TelegramLinkVerifyRequestSchema);
    const link = await getLinkCode(code);
    if (!link || link.sub !== user.sub) throw badRequest('Link code not found or expired. Start again.');

    if (!link.linkedChatTitle) {
      const offset = await getUpdateOffset();
      const updates = await getUpdates(offset);
      await linkStarted(updates);
      const nextOffset = updates.reduce((max, u) => Math.max(max, u.update_id + 1), offset);
      if (nextOffset !== offset) await setUpdateOffset(nextOffset);
    }
    const after = await getLinkCode(code);
    return json(200, { linked: Boolean(after?.linkedChatTitle), chatTitle: after?.linkedChatTitle ?? null });
  },

  'DELETE /telegram/link': async (_event, user) => {
    await putTelegramLink(user.sub, { ...UNLINKED });
    return noContent();
  },

  'POST /telegram/test': async (_event, user) => {
    await requireConfigured();
    const link = await getTelegramLink(user.sub);
    if (!link.chatId) throw badRequest('Telegram is not linked yet');
    await sendMessage(link.chatId, '🔔 Test message from your news dashboard.', { topicId: link.topicId });
    return json(200, { sent: true });
  },
});
