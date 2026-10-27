import { describe, expect, it } from 'vitest';
import { planDigestOverall } from '../src/migrate/digest-overall';

describe('migration to digests with an overall sentiment', () => {
  it('picks only the digests without overall', () => {
    const items = [
      { PK: 'USER#u1', SK: 'DIGEST#2026-10-20T22:05:00Z#2026-10-21', title: 'Old' },
      { PK: 'USER#u1', SK: 'DIGEST#2026-10-28T22:05:00Z#2026-10-29', title: 'New', overall: { sentiment: 'positive', reason: 'r' } },
      { PK: 'USER#u2', SK: 'DIGEST#2026-10-28T22:05:00Z#2026-10-29', title: 'Fallback', overall: null },
      { PK: 'USER#u2', SK: 'SETTINGS', data: {} },
      { PK: 'RUNITEM#r1', SK: 'DIGEST#odd' },
    ];
    expect(planDigestOverall(items)).toEqual([{ PK: 'USER#u1', SK: 'DIGEST#2026-10-20T22:05:00Z#2026-10-21' }]);
  });
});
