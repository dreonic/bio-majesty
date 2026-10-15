import { TelegramLinkVerifyRequestSchema, type TelegramLinkStartResponse } from '@bio-majesty/shared';
import { badRequest, getUser, json, noContent, parseBody } from '../../lib/http';
import { randomId } from '../../lib/ids';
import { createRouter } from '../../lib/router';
import { chatTitle, getBotUsername, getUpdates, isTelegramConfigured, sendMessage } from '../../notify/telegram';
import { deleteLinkCode, getLinkCode, getTelegramState, putLinkCode, putTelegramState, setUpdateOffset } from '../../repo/telegram';

const LINK_TTL_MS = 10 * 60 * 1000;

async function requireConfigured(): Promise<void> {
  if (!(await isTelegramConfigured())) {
    throw badRequest('Telegram is not configured. Add TELEGRAM_BOT_TOKEN to the secret (see README).');
  }
}

export const handler = createRouter({
  'POST /telegram/link': async (event) => {
    await requireConfigured();
    const user = getUser(event);
    const code = randomId(24);
    await putLinkCode(code, user.sub);
    const body: TelegramLinkStartResponse = {
      code,
      deepLink: `https://t.me/${await getBotUsername()}?start=${code}`,
      expiresAt: new Date(Date.now() + LINK_TTL_MS).toISOString(),
    };
    return json(200, body);
  },

  'POST /telegram/link/verify': async (event) => {
    await requireConfigured();
    const { code } = parseBody(event, TelegramLinkVerifyRequestSchema);
    const link = await getLinkCode(code);
    if (!link) throw badRequest('Link code not found or expired. Start again.');

    const state = await getTelegramState();
    const updates = await getUpdates(state.updateOffset);
    const nextOffset = updates.reduce((max, u) => Math.max(max, u.update_id + 1), state.updateOffset);
    const match = updates.find((u) => u.message?.text?.trim() === `/start ${code}`);
    if (!match?.message) {
      if (nextOffset !== state.updateOffset) await setUpdateOffset(nextOffset);
      return json(200, { linked: false, chatTitle: null });
    }

    const title = chatTitle(match.message.chat);
    await putTelegramState({
      chatId: match.message.chat.id,
      chatTitle: title,
      linkedAt: new Date().toISOString(),
      updateOffset: nextOffset,
    });
    await deleteLinkCode(code);
    await sendMessage(match.message.chat.id, '✅ Connected. You will receive news digests and alerts here.');
    return json(200, { linked: true, chatTitle: title });
  },

  'DELETE /telegram/link': async () => {
    const state = await getTelegramState();
    await putTelegramState({ ...state, chatId: null, chatTitle: null, linkedAt: null });
    return noContent();
  },

  'POST /telegram/test': async () => {
    await requireConfigured();
    const state = await getTelegramState();
    if (!state.chatId) throw badRequest('Telegram is not linked yet');
    await sendMessage(state.chatId, '🔔 Test message from the Prodia news dashboard.');
    return json(200, { sent: true });
  },
});
