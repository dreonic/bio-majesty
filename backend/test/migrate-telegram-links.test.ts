import { describe, expect, it } from 'vitest';
import { planOldLinkCleanup, planTelegramLinks } from '../src/migrate/telegram-links';

const items = [
  { PK: 'USER#u1', SK: 'TELEGRAM', chatId: 256896516, topicId: null, chatTitle: 'Van', linkedAt: '2026-10-28T07:47:50.215Z' },
  { PK: 'USER#u2', SK: 'TELEGRAM', chatId: -100, topicId: 42, chatTitle: 'Execs › Acme', linkedAt: '2026-10-28T08:00:00.000Z' },
  { PK: 'USER#u3', SK: 'TELEGRAM', chatId: null, topicId: null, chatTitle: null, linkedAt: null },
  { PK: 'USER#u1', SK: 'TELEGRAM#256896516_0', chatId: 256896516 },
  { PK: 'TELEGRAM', SK: 'BOT', updateOffset: 5 },
];

describe('Telegram links migration', () => {
  it('turns each linked account into one connection, and skips unlinked ones', () => {
    expect(planTelegramLinks(items)).toEqual([
      {
        pk: 'USER#u1',
        link: { id: '256896516_0', chatId: 256896516, topicId: null, chatTitle: 'Van', kind: 'private', linkedAt: '2026-10-28T07:47:50.215Z' },
      },
      {
        pk: 'USER#u2',
        link: { id: '-100_42', chatId: -100, topicId: 42, chatTitle: 'Execs › Acme', kind: 'group', linkedAt: '2026-10-28T08:00:00.000Z' },
      },
    ]);
  });

  it('cleans up every old single-link item, and nothing else', () => {
    expect(planOldLinkCleanup(items)).toEqual([
      { PK: 'USER#u1', SK: 'TELEGRAM' },
      { PK: 'USER#u2', SK: 'TELEGRAM' },
      { PK: 'USER#u3', SK: 'TELEGRAM' },
    ]);
  });
});
