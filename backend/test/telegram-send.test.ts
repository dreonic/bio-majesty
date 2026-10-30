import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/secrets', () => ({ getSecret: async (name: string) => (name === 'TELEGRAM_BOT_TOKEN' ? 'test-token' : undefined) }));
vi.mock('../src/lib/time', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/time')>()), sleep: vi.fn(async () => undefined) }));

import { sleep } from '../src/lib/time';
import { sendMessage } from '../src/notify/telegram';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const limited = (seconds: number) =>
  reply({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${seconds}`, parameters: { retry_after: seconds } }, 429);

describe('Telegram sends', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(sleep).mockClear();
  });

  it('waits as long as Telegram asks and sends again when rate-limited', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(limited(3)).mockResolvedValueOnce(reply({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal('fetch', fetchMock);
    await sendMessage(-100, 'hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sleep).mock.calls[0]![0]).toBeGreaterThanOrEqual(3000);
  });

  it('gives up when the wait is too long or the limit keeps coming back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => limited(120)));
    await expect(sendMessage(-100, 'hello')).rejects.toThrow(/Too Many Requests/);
    expect(sleep).not.toHaveBeenCalled();

    const again = vi.fn(async () => limited(1));
    vi.stubGlobal('fetch', again);
    await expect(sendMessage(-100, 'hello')).rejects.toThrow(/Too Many Requests/);
    expect(again).toHaveBeenCalledTimes(3);
  });
});
