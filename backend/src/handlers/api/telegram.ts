import {
  MAX_TELEGRAM_CONNECTIONS,
  TelegramLinkStartRequestSchema,
  TelegramLinkVerifyRequestSchema,
  type TelegramLinkKind,
  type TelegramLinkStartResponse,
} from '@bio-majesty/shared';
import { badRequest, json, noContent, notFound, parseBody, pathParam } from '../../lib/http';
import { randomId } from '../../lib/ids';
import { createRouter } from '../../lib/router';
import { getBotUsername, getUpdates, isTelegramConfigured, messageDestination, sendMessage, type TelegramUpdate } from '../../notify/telegram';
import {
  deleteTelegramLink,
  getLinkCode,
  getUpdateOffset,
  listTelegramLinks,
  markLinkCodeUsed,
  putLinkCode,
  putTelegramLink,
  setUpdateOffset,
  telegramLinkId,
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

const WRONG_PLACE: Record<TelegramLinkKind, string> = {
  private: 'This code connects a private chat. Open the link from the dashboard instead of sending it here.',
  group: 'This code connects a group or topic. Send the command in the group (or topic) that should get the notifications.',
};

/**
 * Link every account whose /start message is in the batch, not just the caller's: the bot has one
 * update offset, so a message read here is never returned to another account's check. A code only
 * connects the kind of chat it was made for, so opening the bot (where Telegram may send /start by
 * itself) can't take over a code meant for a group.
 */
async function linkStarted(updates: TelegramUpdate[]): Promise<void> {
  for (const { code, update } of startCodes(updates, await getBotUsername())) {
    const link = await getLinkCode(code);
    if (!link || link.linkedChatTitle) continue;
    const message = update.message!;
    const kind: TelegramLinkKind = message.chat.type === 'private' ? 'private' : 'group';
    const { topicId, title } = messageDestination(message);
    if (kind !== link.kind) {
      await sendMessage(message.chat.id, WRONG_PLACE[link.kind], { topicId });
      continue;
    }
    const id = telegramLinkId(message.chat.id, topicId);
    await putTelegramLink(link.sub, { id, chatId: message.chat.id, topicId, chatTitle: title, kind, linkedAt: new Date().toISOString() });
    await markLinkCodeUsed(code, title);
    await sendMessage(message.chat.id, '✅ Connected. You will receive news digests and alerts here.', { topicId });
  }
}

export const handler = createRouter({
  'POST /telegram/link': async (event, user) => {
    await requireConfigured();
    const { kind } = parseBody(event, TelegramLinkStartRequestSchema);
    if ((await listTelegramLinks(user.sub)).length >= MAX_TELEGRAM_CONNECTIONS) {
      throw badRequest(`An account can have at most ${MAX_TELEGRAM_CONNECTIONS} Telegram connections. Disconnect one first.`);
    }
    const code = randomId(24);
    await putLinkCode(code, user.sub, kind);
    const bot = await getBotUsername();
    const body: TelegramLinkStartResponse = {
      kind,
      code,
      deepLink: kind === 'private' ? `https://t.me/${bot}?start=${code}` : null,
      groupCommand: kind === 'group' ? `/start@${bot} ${code}` : null,
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

  'DELETE /telegram/links/{id}': async (event, user) => {
    if (!(await deleteTelegramLink(user.sub, pathParam(event, 'id')))) throw notFound('Telegram connection not found');
    return noContent();
  },

  'POST /telegram/links/{id}/test': async (event, user) => {
    await requireConfigured();
    const link = (await listTelegramLinks(user.sub)).find((l) => l.id === pathParam(event, 'id'));
    if (!link) throw notFound('Telegram connection not found');
    await sendMessage(link.chatId, '🔔 Test message from your news dashboard.', { topicId: link.topicId });
    return json(200, { sent: true });
  },
});
