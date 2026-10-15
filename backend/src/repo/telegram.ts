import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, table, ttlInDays } from './client';
import { keys } from './keys';

export interface TelegramState {
  chatId: number | null;
  chatTitle: string | null;
  linkedAt: string | null;
  /** Next getUpdates offset (so old /start messages are not re-read). */
  updateOffset: number;
}

const EMPTY: TelegramState = { chatId: null, chatTitle: null, linkedAt: null, updateOffset: 0 };

export async function getTelegramState(): Promise<TelegramState> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.telegram() }));
  if (!res.Item) return { ...EMPTY };
  return {
    chatId: (res.Item.chatId as number | null) ?? null,
    chatTitle: (res.Item.chatTitle as string | null) ?? null,
    linkedAt: (res.Item.linkedAt as string | null) ?? null,
    updateOffset: Number(res.Item.updateOffset ?? 0),
  };
}

export async function putTelegramState(state: TelegramState): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.telegram(), ...state } }));
}

export async function setUpdateOffset(offset: number): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.telegram(),
      UpdateExpression: 'SET updateOffset = :o',
      ExpressionAttributeValues: { ':o': offset },
    }),
  );
}

export async function putLinkCode(code: string, sub: string): Promise<void> {
  await ddb().send(
    new PutCommand({ TableName: table(), Item: { ...keys.telegramLink(code), sub, expiresAt: ttlInDays(1) } }),
  );
}

export async function getLinkCode(code: string): Promise<{ sub: string; expiresAt: number } | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.telegramLink(code) }));
  if (!res.Item) return null;
  return { sub: String(res.Item.sub), expiresAt: Number(res.Item.expiresAt) };
}

export async function deleteLinkCode(code: string): Promise<void> {
  await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.telegramLink(code) }));
}
