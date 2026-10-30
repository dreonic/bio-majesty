import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Category } from '@bio-majesty/shared';
import { ddb, queryPrefix, stripKeys, table } from './client';
import { keys, profilePk, type ProfileId } from './keys';

export async function listCategories(profileId: ProfileId): Promise<Category[]> {
  const items = await queryPrefix(profilePk(profileId), 'CATEGORY#');
  return items.map((i) => stripKeys(i) as unknown as Category).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCategory(profileId: ProfileId, id: string): Promise<Category | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.category(profileId, id) }));
  return res.Item ? (stripKeys(res.Item) as unknown as Category) : null;
}

export async function putCategory(profileId: ProfileId, category: Category): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.category(profileId, category.id), ...category } }));
}

export async function deleteCategory(profileId: ProfileId, id: string): Promise<void> {
  await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.category(profileId, id) }));
}

export async function updateCategory(profileId: ProfileId, id: string, patch: (c: Category) => Category): Promise<Category | null> {
  const current = await getCategory(profileId, id);
  if (!current) return null;
  const next = { ...patch(current), updatedAt: new Date().toISOString() };
  await putCategory(profileId, next);
  return next;
}
