import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Conversation } from '@bio-majesty/shared';
import type { UIMessage } from 'ai';
import { deleteObject, getJson, putJson, s3Keys } from '../storage/s3';
import { ddb, stripKeys, table } from './client';
import { keys, profilePk, type ProfileId } from './keys';

export async function listConversations(profileId: ProfileId): Promise<Conversation[]> {
  const res = await ddb().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': profilePk(profileId), ':p': 'CHAT#' },
    }),
  );
  return (res.Items ?? [])
    .map((i) => stripKeys(i) as unknown as Conversation)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getConversation(profileId: ProfileId, id: string): Promise<Conversation | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.conversation(profileId, id) }));
  return res.Item ? (stripKeys(res.Item) as unknown as Conversation) : null;
}

export async function saveConversation(profileId: ProfileId, conversation: Conversation, messages: UIMessage[]): Promise<void> {
  await putJson(s3Keys.chat(profileId, conversation.id), messages);
  await ddb().send(
    new PutCommand({ TableName: table(), Item: { ...keys.conversation(profileId, conversation.id), ...conversation } }),
  );
}

export async function loadMessages(profileId: ProfileId, id: string): Promise<UIMessage[]> {
  return (await getJson<UIMessage[]>(s3Keys.chat(profileId, id))) ?? [];
}

export async function deleteConversation(profileId: ProfileId, id: string): Promise<void> {
  await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.conversation(profileId, id) }));
  await deleteObject(s3Keys.chat(profileId, id));
}
