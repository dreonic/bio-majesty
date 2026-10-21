import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Category } from '@bio-majesty/shared';
import { ddb, queryPrefix, stripKeys, table } from './client';
import { accountPk, keys } from './keys';

export async function listCategories(sub: string): Promise<Category[]> {
  const items = await queryPrefix(accountPk(sub), 'CATEGORY#');
  return items.map((i) => stripKeys(i) as unknown as Category).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCategory(sub: string, id: string): Promise<Category | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.category(sub, id) }));
  return res.Item ? (stripKeys(res.Item) as unknown as Category) : null;
}

export async function putCategory(sub: string, category: Category): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.category(sub, category.id), ...category } }));
}

export async function deleteCategory(sub: string, id: string): Promise<void> {
  await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.category(sub, id) }));
}

export async function updateCategory(sub: string, id: string, patch: (c: Category) => Category): Promise<Category | null> {
  const current = await getCategory(sub, id);
  if (!current) return null;
  const next = { ...patch(current), updatedAt: new Date().toISOString() };
  await putCategory(sub, next);
  return next;
}
