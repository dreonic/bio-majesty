import { describe, expect, it } from 'vitest';
import { HAIKU, planHaikuModels } from '../src/migrate/models-haiku';

describe('Haiku migration', () => {
  it('puts every saved task on Haiku and drops a fallback that would be Haiku too', () => {
    const settings = {
      PK: 'USER#u1',
      SK: 'SETTINGS',
      data: {
        models: {
          tagging: { model: 'anthropic:claude-opus-5-5', fallbackModel: HAIKU, reasoning: 'low' },
          chat: { model: 'openai:gpt-6-astra', fallbackModel: null, reasoning: 'medium' },
        },
      },
    };
    expect(planHaikuModels([settings])).toEqual([
      {
        key: { PK: 'USER#u1', SK: 'SETTINGS' },
        models: {
          tagging: { model: HAIKU, fallbackModel: null, reasoning: 'low' },
          chat: { model: HAIKU, fallbackModel: null, reasoning: 'medium' },
        },
      },
    ]);
  });

  it('skips accounts already on Haiku, without saved models, and other items', () => {
    expect(
      planHaikuModels([
        { PK: 'USER#u1', SK: 'SETTINGS', data: { models: { chat: { model: HAIKU, fallbackModel: null } } } },
        { PK: 'USER#u2', SK: 'SETTINGS', data: { profile: {} } },
        { PK: 'USER#u3', SK: 'CATEGORY#x', data: { models: { chat: { model: 'x' } } } },
      ]),
    ).toEqual([]);
  });
});
