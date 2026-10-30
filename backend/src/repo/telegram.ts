import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { TelegramLinkKind } from '@bio-majesty/shared';
import { ddb, queryPrefix, stripKeys, table, ttlInDays } from './client';
import { asProfileId, keys, profilePk, type ProfileId } from './keys';

/** One chat (and, in a forum supergroup, one topic) that gets the profile's digests and alerts. */
export interface TelegramLink {
  /** `<chatId>_<topicId or 0>`: connecting the same chat or topic again replaces it. */
  id: string;
  chatId: number;
  /** Topic (message_thread_id) inside a forum supergroup; null for a private chat, a plain group or the General topic. */
  topicId: number | null;
  /** "Chat" or "Group › Topic". */
  chatTitle: string;
  kind: TelegramLinkKind;
  linkedAt: string;
}

export const telegramLinkId = (chatId: number, topicId: number | null) => `${chatId}_${topicId ?? 0}`;

/** The profile's connections, oldest first. */
export async function listTelegramLinks(profileId: ProfileId): Promise<TelegramLink[]> {
  const items = await queryPrefix(profilePk(profileId), 'TELEGRAM#');
  return items.map((i) => stripKeys(i) as unknown as TelegramLink).sort((a, b) => a.linkedAt.localeCompare(b.linkedAt));
}

export async function putTelegramLink(profileId: ProfileId, link: TelegramLink): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.telegramChat(profileId, link.id), ...link } }));
}

export async function deleteTelegramLink(profileId: ProfileId, id: string): Promise<boolean> {
  const res = await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.telegramChat(profileId, id), ReturnValues: 'ALL_OLD' }));
  return Boolean(res.Attributes);
}

/** Next getUpdates offset of the (single) bot, so old /start messages are not re-read. */
export async function getUpdateOffset(): Promise<number> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.telegramBot() }));
  return Number(res.Item?.updateOffset ?? 0);
}

export async function setUpdateOffset(offset: number): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.telegramBot(),
      UpdateExpression: 'SET updateOffset = :o',
      ExpressionAttributeValues: { ':o': offset },
    }),
  );
}

export interface LinkCode {
  profileId: ProfileId;
  /** Which kind of chat the code may connect: a private code is refused in a group, and the other way round. */
  kind: TelegramLinkKind;
  expiresAt: number;
  /** Set once the code's /start message was seen (possibly while another profile was checking). */
  linkedChatTitle: string | null;
}

export async function putLinkCode(code: string, profileId: ProfileId, kind: TelegramLinkKind): Promise<void> {
  await ddb().send(
    new PutCommand({ TableName: table(), Item: { ...keys.telegramLink(code), profileId, kind, expiresAt: ttlInDays(1) } }),
  );
}

export async function getLinkCode(code: string): Promise<LinkCode | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.telegramLink(code) }));
  if (!res.Item) return null;
  return {
    profileId: asProfileId(String(res.Item.profileId)),
    kind: res.Item.kind as TelegramLinkKind,
    expiresAt: Number(res.Item.expiresAt),
    linkedChatTitle: (res.Item.linkedChatTitle as string | undefined) ?? null,
  };
}

export async function markLinkCodeUsed(code: string, chatTitle: string): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.telegramLink(code),
      UpdateExpression: 'SET linkedChatTitle = :t',
      ExpressionAttributeValues: { ':t': chatTitle },
    }),
  );
}
