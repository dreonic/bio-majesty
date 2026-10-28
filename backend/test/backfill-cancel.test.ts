import { ListExecutionsCommand, SFNClient, StartExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import type { Category } from '@bio-majesty/shared';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TABLE_NAME = 'test-table';
process.env.BACKFILL_STATE_MACHINE_ARN = 'arn:aws:states:ap-southeast-1:111122223333:stateMachine:Backfill';

const categories = new Map<string, Category>();
const cancelledRuns: string[] = [];
vi.mock('../src/repo/categories', () => ({
  getCategory: async (_sub: string, id: string) => categories.get(id) ?? null,
  listCategories: async () => [...categories.values()],
  putCategory: async (_sub: string, c: Category) => void categories.set(c.id, c),
  deleteCategory: async (_sub: string, id: string) => void categories.delete(id),
  updateCategory: async (_sub: string, id: string, patch: (c: Category) => Category) => {
    const current = categories.get(id);
    if (!current) return null;
    categories.set(id, patch(current));
    return categories.get(id);
  },
}));
vi.mock('../src/repo/runs', () => ({ cancelRun: async (_sub: string, id: string) => void cancelledRuns.push(id) }));

const sfn = mockClient(SFNClient);
const { handler } = await import('../src/handlers/api/categories');
const { startBackfillRun, stopBackfillRuns } = await import('../src/lib/aws');

const request = (method: string, resource: string, id: string) =>
  handler({
    httpMethod: method,
    resource,
    headers: {},
    pathParameters: { id },
    body: null,
    requestContext: { authorizer: { claims: { sub: 'u1', 'cognito:groups': 'dashboard-users' } } },
  } as unknown as APIGatewayProxyEvent);

function category(id: string, status: Category['backfill']['status'], runId: string | null = null): Category {
  return {
    id,
    name: id,
    description: '',
    color: '#2a78d6',
    search: { enabled: true, queries: [{ q: 'acme', edition: 'ID:id' }], exclude: [], sources: { googleNews: true, gdelt: false } },
    backfill: { period: { amount: 6, unit: 'months' }, status, runId, startedAt: null, completedAt: null, error: null },
    active: false,
    createdAt: '',
    updatedAt: '',
  };
}

beforeEach(() => {
  categories.clear();
  cancelledRuns.length = 0;
  sfn.reset();
  sfn.on(ListExecutionsCommand).resolves({
    executions: [
      { name: 'u1-cat1-1761600000000', executionArn: 'arn:exec:cat1', stateMachineArn: '', status: 'RUNNING', startDate: new Date() },
      { name: 'u1-cat10-1761600000000', executionArn: 'arn:exec:cat10', stateMachineArn: '', status: 'RUNNING', startDate: new Date() },
      { name: 'u2-cat1-1761600000000', executionArn: 'arn:exec:u2', stateMachineArn: '', status: 'RUNNING', startDate: new Date() },
    ],
  });
  sfn.on(StopExecutionCommand).resolves({ stopDate: new Date() });
});

describe('backfill executions', () => {
  it('names each execution after its account and category', async () => {
    sfn.on(StartExecutionCommand).resolves({ executionArn: 'arn:exec:new' });
    await startBackfillRun('u1', 'cat1', { amount: 10, unit: 'days' });
    const input = sfn.commandCalls(StartExecutionCommand)[0]!.args[0].input;
    expect(input.name).toMatch(/^u1-cat1-\d+$/);
    expect(JSON.parse(input.input!)).toEqual({ mode: 'backfill', categoryId: 'cat1', period: { amount: 10, unit: 'days' }, sub: 'u1' });
  });

  it("stops only that category's executions (not cat10's, not another account's)", async () => {
    expect(await stopBackfillRuns('u1', 'cat1')).toBe(1);
    expect(sfn.commandCalls(StopExecutionCommand).map((c) => c.args[0].input.executionArn)).toEqual(['arn:exec:cat1']);
  });
});

describe('cancelling a backfill', () => {
  it('stops the run, marks it cancelled, and lets the category join the daily run', async () => {
    categories.set('cat1', category('cat1', 'running', 'run1'));
    const res = await request('POST', '/categories/{id}/backfill/cancel', 'cat1');
    expect(res.statusCode).toBe(200);
    expect(sfn.commandCalls(StopExecutionCommand)).toHaveLength(1);
    expect(cancelledRuns).toEqual(['run1']);
    expect(categories.get('cat1')).toMatchObject({ active: true, backfill: { status: 'cancelled' } });
  });

  it('refuses when nothing is in progress', async () => {
    categories.set('cat1', category('cat1', 'done', 'run1'));
    expect((await request('POST', '/categories/{id}/backfill/cancel', 'cat1')).statusCode).toBe(400);
    expect(sfn.commandCalls(StopExecutionCommand)).toHaveLength(0);
  });

  it("doesn't touch an older run while the new one hasn't started", async () => {
    categories.set('cat1', category('cat1', 'pending', 'previous-run'));
    expect((await request('POST', '/categories/{id}/backfill/cancel', 'cat1')).statusCode).toBe(200);
    expect(cancelledRuns).toEqual([]);
  });

  it('stops the backfill of a category that is deleted', async () => {
    categories.set('cat1', category('cat1', 'running', 'run1'));
    expect((await request('DELETE', '/categories/{id}', 'cat1')).statusCode).toBe(204);
    expect(categories.has('cat1')).toBe(false);
    expect(sfn.commandCalls(StopExecutionCommand)).toHaveLength(1);
    expect(cancelledRuns).toEqual(['run1']);
  });
});
