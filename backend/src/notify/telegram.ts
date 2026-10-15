import type { Digest, VolumeAnomaly } from '@bio-majesty/shared';
import { getSecret } from '../lib/secrets';

/**
 * Minimal Telegram Bot API client. Linking uses getUpdates (no public webhook):
 * the exec opens t.me/<bot>?start=<code>, presses Start, and the dashboard
 * polls /telegram/link/verify until the /start message is seen.
 */
const API = 'https://api.telegram.org';

export class TelegramNotConfiguredError extends Error {
  constructor() {
    super('TELEGRAM_BOT_TOKEN is not set in the secret');
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: TelegramChat; text?: string };
}

async function token(): Promise<string> {
  const t = await getSecret('TELEGRAM_BOT_TOKEN');
  if (!t) throw new TelegramNotConfiguredError();
  return t;
}

export async function isTelegramConfigured(): Promise<boolean> {
  return Boolean(await getSecret('TELEGRAM_BOT_TOKEN'));
}

async function call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API}/bot${await token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as TelegramResponse<T>;
  if (!data.ok || data.result === undefined) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

let botUsername: string | undefined;

export async function getBotUsername(): Promise<string> {
  botUsername ??= (await call<{ username: string }>('getMe')).username;
  return botUsername;
}

export function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
}

export interface SendOptions {
  buttonText?: string;
  buttonUrl?: string;
}

export async function sendMessage(chatId: number, html: string, opts: SendOptions = {}): Promise<void> {
  // Telegram only accepts public https URLs in inline buttons.
  const button =
    opts.buttonUrl && opts.buttonUrl.startsWith('https://')
      ? { reply_markup: { inline_keyboard: [[{ text: opts.buttonText ?? 'Open dashboard', url: opts.buttonUrl }]] } }
      : {};
  await call('sendMessage', {
    chat_id: chatId,
    text: truncate(html, 4000),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...button,
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const SENTIMENT_ICON = { positive: '🟢', negative: '🔴', neutral: '⚪', undecided: '🟡' } as const;

export function chatTitle(chat: TelegramChat): string {
  return chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id));
}

export function formatDigestMessage(digest: Digest): string {
  const c = digest.counts;
  const lines = [
    `<b>${escapeHtml(digest.title)}</b>`,
    '',
    escapeHtml(digest.summary),
    '',
    ...digest.highlights.map((h) => `${SENTIMENT_ICON[h.sentiment]} <b>${escapeHtml(h.title)}</b>\n    ${escapeHtml(h.why)}`),
    '',
    `${c.total} to review · ${c.positive} positive · ${c.negative} negative · ${c.neutral} neutral · ${c.undecided} undecided`,
  ];
  return lines.join('\n');
}

const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatVolumeAlert(symbol: string, a: Omit<VolumeAnomaly, 'notifiedAt'>): string {
  const ticker = escapeHtml(symbol.replace(/\.JK$/, ''));
  const change = a.changePercent !== null ? ` (${a.changePercent > 0 ? '+' : ''}${a.changePercent.toFixed(2)}%)` : '';
  const price = a.close !== null ? ` Price ${numberFmt.format(a.close)}${change}.` : '';
  const ratio = `${a.ratio.toFixed(1)}× the 20-day average (${compactFmt.format(a.averageVolume)})`;
  return a.source === 'intraday'
    ? `📊 <b>Unusual ${ticker} trading volume today</b>\n${compactFmt.format(a.volume)} shares traded so far — ${ratio}.${price}`
    : `📊 <b>Unusual ${ticker} trading volume on ${a.date}</b>\n${compactFmt.format(a.volume)} shares — ${ratio}.${price}`;
}

export function formatFailureMessage(kind: string, error: string): string {
  return `⚠️ <b>${escapeHtml(kind)} failed</b>\n${escapeHtml(error.slice(0, 1500))}\n\nCheck the run history in Settings.`;
}
