import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, table, ttlInDays } from './client';
import { keys } from './keys';

/** The Telegram chat an account's digests and alerts go to. */
export interface TelegramLink {
  chatId: number | null;
  chatTitle: string | null;
  linkedAt: string | null;
}

const UNLINKED: TelegramLink = { chatId: null, chatTitle: null, linkedAt: null };

export async function getTelegramLink(sub: string): Promise<TelegramLink> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.telegram(sub) }));
  if (!res.Item) return { ...UNLINKED };
  return {
    chatId: (res.Item.chatId as number | null) ?? null,
    chatTitle: (res.Item.chatTitle as string | null) ?? null,
    linkedAt: (res.Item.linkedAt as string | null) ?? null,
  };
}

export async function putTelegramLink(sub: string, link: TelegramLink): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.telegram(sub), ...link } }));
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
  sub: string;
  expiresAt: number;
  /** Set once the code's /start message was seen (possibly while another account was checking). */
  linkedChatTitle: string | null;
}

export async function putLinkCode(code: string, sub: string): Promise<void> {
  await ddb().send(
    new PutCommand({ TableName: table(), Item: { ...keys.telegramLink(code), sub, expiresAt: ttlInDays(1) } }),
  );
}

export async function getLinkCode(code: string): Promise<LinkCode | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.telegramLink(code) }));
  if (!res.Item) return null;
  return {
    sub: String(res.Item.sub),
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
