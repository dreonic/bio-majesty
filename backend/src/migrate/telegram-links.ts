/**
 * Accounts now have several Telegram connections (`TELEGRAM#<id>` items) instead of one `TELEGRAM`
 * item; used by scripts/migrate-telegram-links.ts. Pure: no AWS calls.
 */
import type { TelegramLink } from '../repo/telegram';
import { telegramLinkId } from '../repo/telegram';

export type Item = Record<string, unknown>;

const isOldLink = (i: Item) => String(i.PK).startsWith('USER#') && i.SK === 'TELEGRAM';

/** The connection each linked old item becomes (negative chat ids are groups); unlinked ones become nothing. */
export function planTelegramLinks(items: Item[]): { pk: string; link: TelegramLink }[] {
  return items.flatMap((i) => {
    if (!isOldLink(i) || typeof i.chatId !== 'number') return [];
    const chatId = i.chatId;
    const topicId = typeof i.topicId === 'number' ? i.topicId : null;
    const link: TelegramLink = {
      id: telegramLinkId(chatId, topicId),
      chatId,
      topicId,
      chatTitle: String(i.chatTitle ?? chatId),
      kind: chatId > 0 ? 'private' : 'group',
      linkedAt: String(i.linkedAt ?? new Date(0).toISOString()),
    };
    return [{ pk: String(i.PK), link }];
  });
}

/** Old single-link items, linked or not (removed by --cleanup). */
export function planOldLinkCleanup(items: Item[]): { PK: string; SK: string }[] {
  return items.filter(isOldLink).map((i) => ({ PK: String(i.PK), SK: 'TELEGRAM' }));
}
