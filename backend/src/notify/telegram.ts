import { displaySymbol, type Digest, type StockAsset, type VolumeAnomaly } from '@bio-majesty/shared';
import { getSecret } from '../lib/secrets';
import { sleep } from '../lib/time';

/**
 * Minimal Telegram Bot API client. Linking uses getUpdates (no public webhook):
 * a user opens t.me/<bot>?start=<code> and presses Start, or sends
 * /start@<bot> <code> in a group or one of its topics, and the dashboard polls
 * /telegram/link/verify until that message is seen.
 */
const API = 'https://api.telegram.org';

export class TelegramNotConfiguredError extends Error {
  constructor() {
    super('TELEGRAM_BOT_TOKEN is not set in the API keys parameter');
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  /** On a 429 ("Too Many Requests"), how many seconds to wait before sending again. */
  parameters?: { retry_after?: number };
}

/** Rate-limited sends wait and try again this often, if Telegram's wait is short enough. */
const RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_S = 30;

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  chat: TelegramChat;
  text?: string;
  /** Topic of a forum supergroup the message was sent in. */
  message_thread_id?: number;
  is_topic_message?: boolean;
  /** In a topic, messages reply to the topic's creation message, which carries its name. */
  reply_to_message?: { forum_topic_created?: { name: string } };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

async function token(): Promise<string> {
  const t = await getSecret('TELEGRAM_BOT_TOKEN');
  if (!t) throw new TelegramNotConfiguredError();
  return t;
}

export async function isTelegramConfigured(): Promise<boolean> {
  return Boolean(await getSecret('TELEGRAM_BOT_TOKEN'));
}

/**
 * Telegram limits how fast a bot sends (about 1 message a second per chat, 20 a minute per group):
 * over that it answers 429 with the seconds to wait, so wait that long and send again.
 */
async function call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/bot${await token()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as TelegramResponse<T>;
    if (data.ok && data.result !== undefined) return data.result;
    const wait = data.parameters?.retry_after;
    if (data.error_code === 429 && wait !== undefined && wait <= MAX_RATE_LIMIT_WAIT_S && attempt < RATE_LIMIT_RETRIES) {
      await sleep(wait * 1000 + Math.random() * 1000);
      continue;
    }
    throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  }
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
  /** Post in this topic of a forum supergroup. */
  topicId?: number | null;
}

export async function sendMessage(chatId: number, html: string, opts: SendOptions = {}): Promise<void> {
  // Telegram only accepts public https URLs in inline buttons.
  const button =
    opts.buttonUrl && opts.buttonUrl.startsWith('https://')
      ? { reply_markup: { inline_keyboard: [[{ text: opts.buttonText ?? 'Open dashboard', url: opts.buttonUrl }]] } }
      : {};
  await call('sendMessage', {
    chat_id: chatId,
    ...(opts.topicId ? { message_thread_id: opts.topicId } : {}),
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
// The dashboard's wording (SENTIMENT_META in the frontend).
const SENTIMENT_LABEL = { positive: 'Positive', negative: 'Negative', neutral: 'Neutral', undecided: 'Undecided' } as const;

export function chatTitle(chat: TelegramChat): string {
  return chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id));
}

/** Where a message was sent: the chat, plus its topic in a forum supergroup ("Group › Topic"). */
export function messageDestination(message: TelegramMessage): { topicId: number | null; title: string } {
  const topicId = message.is_topic_message && message.message_thread_id ? message.message_thread_id : null;
  const topicName = topicId ? (message.reply_to_message?.forum_topic_created?.name ?? 'topic') : null;
  return { topicId, title: topicName ? `${chatTitle(message.chat)} › ${topicName}` : chatTitle(message.chat) };
}

/** Title, summary, overall sentiment and counts; the highlights stay in the dashboard. */
export function formatDigestMessage(digest: Digest): string {
  const c = digest.counts;
  const o = digest.overall;
  const lines = [
    `<b>${escapeHtml(digest.title)}</b>`,
    '',
    escapeHtml(digest.summary),
    '',
    ...(o ? [`Overall: ${SENTIMENT_ICON[o.sentiment]} <b>${SENTIMENT_LABEL[o.sentiment]}</b> — ${escapeHtml(o.reason)}`] : []),
    `📰 ${c.total} new item${c.total === 1 ? '' : 's'} to review (${c.positive} positive · ${c.negative} negative · ${c.neutral} neutral · ${c.undecided} undecided)`,
  ];
  return lines.join('\n');
}

const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatVolumeAlert(asset: Pick<StockAsset, 'id' | 'type' | 'decimals'>, a: Omit<VolumeAnomaly, 'notifiedAt'>): string {
  const ticker = escapeHtml(displaySymbol(asset.id));
  const priceFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: asset.decimals, maximumFractionDigits: asset.decimals });
  const change = a.changePercent !== null ? ` (${a.changePercent > 0 ? '+' : ''}${a.changePercent.toFixed(2)}%)` : '';
  const price = a.close !== null ? ` Price ${priceFmt.format(a.close)}${change}.` : '';
  const ratio = `${a.ratio.toFixed(1)}× the 20-day average (${compactFmt.format(a.averageVolume)})`;
  // Stocks and ETFs trade shares; crypto, futures and the like trade other units.
  const shares = asset.type === 'EQUITY' || asset.type === 'ETF';
  return a.source === 'intraday'
    ? `📊 <b>Unusual ${ticker} trading volume today</b>\n${compactFmt.format(a.volume)} ${shares ? 'shares traded' : 'traded'} so far — ${ratio}.${price}`
    : `📊 <b>Unusual ${ticker} trading volume on ${a.date}</b>\n${compactFmt.format(a.volume)} ${shares ? 'shares' : 'traded'} — ${ratio}.${price}`;
}

export function formatFailureMessage(kind: string, error: string): string {
  return `⚠️ <b>${escapeHtml(kind)} failed</b>\n${escapeHtml(error.slice(0, 1500))}\n\nCheck the run history in Settings.`;
}
