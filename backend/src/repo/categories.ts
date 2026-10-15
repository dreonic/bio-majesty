import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Category } from '@bio-majesty/shared';
import { ddb, stripKeys, table } from './client';
import { keys } from './keys';

export async function listCategories(): Promise<Category[]> {
  const res = await ddb().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'CATEGORY' },
    }),
  );
  return (res.Items ?? [])
    .map((i) => stripKeys(i) as unknown as Category)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCategory(id: string): Promise<Category | null> {
  const res = await ddb().send(new GetCommand({ TableName: table(), Key: keys.category(id) }));
  return res.Item ? (stripKeys(res.Item) as unknown as Category) : null;
}

export async function putCategory(category: Category): Promise<void> {
  await ddb().send(new PutCommand({ TableName: table(), Item: { ...keys.category(category.id), ...category } }));
}

export async function deleteCategory(id: string): Promise<void> {
  await ddb().send(new DeleteCommand({ TableName: table(), Key: keys.category(id) }));
}

export async function updateCategory(id: string, patch: (c: Category) => Category): Promise<Category | null> {
  const current = await getCategory(id);
  if (!current) return null;
  const next = { ...patch(current), updatedAt: new Date().toISOString() };
  await putCategory(next);
  return next;
}
