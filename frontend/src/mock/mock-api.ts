import {
  CATEGORY_COLORS,
  DEFAULT_TIME_ZONE,
  detectVolumeAnomalies,
  effectiveTags,
  midnightInZone,
  SENTIMENTS,
  type Article,
  type Category,
  type Sentiment,
  type StockRange,
} from '@bio-majesty/shared';
import type { RuntimeConfig } from '../app/config';
import { formatDate, formatPercent, formatPrice } from '../lib/format';
import * as fx from './fixtures';

/**
 * In-browser stand-in for the API used by `npm run dev:mock`. Intercepts
 * fetch() calls to the configured apiUrl and serves fictional sample data,
 * including a streamed chat answer, so the UI can be reviewed without AWS.
 */
export const MOCK_CONFIG: RuntimeConfig = {
  stage: 'demo',
  region: 'ap-southeast-1',
  timeZone: DEFAULT_TIME_ZONE,
  apiUrl: 'https://mock.invalid/api/',
  cognito: { authority: 'https://mock.invalid', clientId: 'mock', domain: 'https://mock.invalid' },
};

const state = {
  articles: [...fx.articles],
  categories: [...fx.categories],
  settings: structuredClone(fx.settings),
  conversations: [...fx.conversations],
  chats: new Map<string, unknown[]>(),
  decisions: [] as { changed: boolean }[],
};

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function list(url: URL) {
  const status = url.searchParams.get('status') ?? 'APPROVED';
  const from = url.searchParams.get('from');
  const cats = url.searchParams.get('categories')?.split(',').filter(Boolean) ?? [];
  const sents = url.searchParams.get('sentiments')?.split(',').filter(Boolean) ?? [];
  const q = url.searchParams.get('q')?.toLowerCase();
  const items = state.articles
    .filter((a) => a.status === status)
    // Like the API: news dates are days on the exec's calendar.
    .filter((a) => !from || a.publishedAt >= midnightInZone(DEFAULT_TIME_ZONE, from).toISOString())
    .filter((a) => !cats.length || effectiveTags(a).categoryIds.some((c) => cats.includes(c)))
    .filter((a) => !sents.length || sents.includes(effectiveTags(a).sentiment))
    .filter((a) => !q || `${a.title} ${a.suggestion?.summary}`.toLowerCase().includes(q))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { items, nextCursor: null };
}

function stock(range: StockRange) {
  const intraday = range === '1D' || range === '5D';
  const days: Record<StockRange, number> = { '1D': 4, '5D': 8, '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '5Y': 1830, MAX: 4000 };
  const cutoff = Date.now() / 1000 - days[range] * 86400;
  let candles = (intraday ? fx.intradayCandles : fx.dailyCandles).filter((c) => c.time >= cutoff);
  if (range === '1D') {
    const lastDay = new Date((candles[candles.length - 1]!.time + 7 * 3600) * 1000).toISOString().slice(0, 10);
    candles = candles.filter((c) => new Date((c.time + 7 * 3600) * 1000).toISOString().slice(0, 10) === lastDay);
  }
  const last = fx.dailyCandles[fx.dailyCandles.length - 1]!;
  const prev = fx.dailyCandles[fx.dailyCandles.length - 2]!;
  // Like a real quote: the time of the last trade (the latest 15-minute bar), not the time of the request.
  const lastBar = fx.intradayCandles[fx.intradayCandles.length - 1];
  return {
    symbol: state.settings.stock.symbol,
    range,
    interval: intraday ? '15m' : range === '5Y' || range === 'MAX' ? '1wk' : '1d',
    candles,
    quote: {
      symbol: state.settings.stock.symbol,
      price: last.close,
      previousClose: prev.close,
      change: last.close - prev.close,
      changePercent: ((last.close - prev.close) / prev.close) * 100,
      dayHigh: last.high,
      dayLow: last.low,
      volume: last.volume,
      currency: 'IDR',
      marketTime: lastBar ? new Date(lastBar.time * 1000).toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      provider: 'demo',
    },
    stale: false,
    lastSuccessAt: new Date().toISOString(),
    lastError: null,
  };
}

/** The article's calendar day in Jakarta as a UTC-midnight timestamp (the candles' time convention). */
function jakartaDay(iso: string): number {
  const d = new Date(new Date(iso).getTime() + 7 * 3600_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

function markers(from: string | null) {
  const fromIso = from ? new Date(`${from}T00:00:00+07:00`).toISOString() : '';
  return state.articles
    .filter((a) => a.status === 'APPROVED' && a.publishedAt >= fromIso)
    .map((a) => ({ articleId: a.id, time: jakartaDay(a.publishedAt), sentiment: effectiveTags(a).sentiment, title: a.title }));
}

// Keywords that map a chat question to a demo category (the real chat uses semantic search).
const DEMO_TOPICS: [RegExp, string][] = [
  [/regulat|ministry|tariff|accreditation/, 'c-reg'],
  [/proline|diagnostic line|reagent/, 'c-proline'],
  [/competitor|rival/, 'c-comp'],
  [/digital|\bapp\b/, 'c-digital'],
];

/** Saved articles matching the question's sentiment words, topic and "last N days / month / quarter". */
function demoSearch(question: string) {
  const q = question.toLowerCase();
  const sentiments = SENTIMENTS.filter((s) => q.includes(s));
  const categoryIds = DEMO_TOPICS.filter(([re]) => re.test(q)).map(([, id]) => id);
  const lastDays = /last (\d+) days/.exec(q)?.[1];
  const days = lastDays ? Number(lastDays) : q.includes('quarter') ? 92 : q.includes('month') ? 31 : q.includes('week') ? 7 : null;
  const fromIso = days ? new Date(Date.now() - days * 86_400_000).toISOString() : '';
  const matches = state.articles
    .filter((a) => a.status === 'APPROVED' && a.publishedAt >= fromIso)
    .filter((a) => !categoryIds.length || effectiveTags(a).categoryIds.some((c) => categoryIds.includes(c)))
    .filter((a) => !sentiments.length || sentiments.includes(effectiveTags(a).sentiment))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    // The fixtures reuse headlines across dates; count and cite each story once.
    .filter((a, i, all) => all.findIndex((b) => b.title === a.title) === i);
  // "Compare positive and negative…" cites the newest of each, not just the newest overall.
  const sources =
    sentiments.length > 1 ? sentiments.flatMap((s) => matches.filter((a) => effectiveTags(a).sentiment === s).slice(0, 2)) : matches.slice(0, 3);
  return { matches, sources, days };
}

/** PRDA's close on the article's day (or the next trading day) and the change from the previous close. */
function demoPriceNote(publishedAt: string): string {
  const i = fx.dailyCandles.findIndex((c) => c.time >= jakartaDay(publishedAt));
  if (i < 1) return '';
  const c = fx.dailyCandles[i]!;
  const prev = fx.dailyCandles[i - 1]!;
  return ` PRDA closed at ${formatPrice(c.close)} (${formatPercent(((c.close - prev.close) / prev.close) * 100)}) on ${formatDate(c.time * 1000)}.`;
}

function chatStream(body: { id: string; message: { id: string; parts: { type: string; text?: string }[] } }) {
  const question = body.message.parts.map((p) => p.text ?? '').join(' ');
  const { matches, sources, days } = demoSearch(question);
  const withPrices = /trade|price|stock|share/i.test(question);
  const counts = SENTIMENTS.map((s) => [s, matches.filter((a) => effectiveTags(a).sentiment === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');
  const answer = [
    "Here's what the saved news says (demo answer):",
    '',
    matches.length
      ? `${matches.length} matching saved article${matches.length === 1 ? '' : 's'}${days ? ` from the last ${days} days` : ''} (${counts}). Most recent:`
      : 'No saved articles in the demo data match that question.',
    '',
    ...sources.map(
      (a) =>
        `- **${effectiveTags(a).sentiment}** — [${a.title}](${a.url}), ${a.publishedAt.slice(0, 10)}: ${a.suggestion?.summary.split('.')[0]}.${withPrices ? demoPriceNote(a.publishedAt) : ''}`,
    ),
    '',
    'In the deployed dashboard the assistant searches your real saved articles and PRDA prices, and cites each source.',
  ].join('\n');
  const parts: unknown[] = [
    { type: 'start', messageId: `msg-${Date.now()}` },
    { type: 'start-step' },
    { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'searchNews' },
    { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'searchNews', input: { query: question.slice(0, 60) } },
    {
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: {
        results: sources.map((a) => ({
          id: a.id,
          title: a.title,
          url: a.url,
          sourceName: a.sourceName,
          publishedAt: a.publishedAt.slice(0, 10),
          sentiment: effectiveTags(a).sentiment,
          categories: [],
          summary: a.suggestion?.summary,
        })),
      },
    },
    { type: 'finish-step' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    ...answer.match(/.{1,24}/gs)!.map((delta) => ({ type: 'text-delta', id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish' },
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
        await delay(part && (part as { type: string }).type === 'text-delta' ? 25 : 250);
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
      const now = new Date().toISOString();
      if (!state.conversations.some((c) => c.id === body.id)) {
        state.conversations.unshift({ id: body.id, title: question.slice(0, 77) || 'New conversation', createdAt: now, updatedAt: now });
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

async function route(method: string, url: URL, body: unknown): Promise<Response> {
  const path = url.pathname.replace(/^\/api\//, '');
  const seg = path.split('/');
  await delay(150);

  if (method === 'GET' && path === 'news') return json(list(url));
  if (method === 'GET' && path === 'news/counts') {
    return json({
      pending: state.articles.filter((a) => a.status === 'PENDING').length,
      filtered: state.articles.filter((a) => a.status === 'FILTERED').length,
    });
  }
  if (seg[0] === 'news' && seg[1] && seg[1] !== 'bulk') {
    const article = state.articles.find((a) => a.id === seg[1]);
    if (!article) return json({ error: 'not_found', message: 'Article not found' }, 404);
    if (method === 'GET') return json({ ...article, text: fx.articleText(article) });
    if (method === 'PATCH') return json(review(article, body as Parameters<typeof review>[1]));
  }
  if (method === 'POST' && path === 'news/bulk') {
    const req = body as { ids: string[]; action: 'approve' | 'reject' };
    for (const id of req.ids) {
      const a = state.articles.find((x) => x.id === id);
      if (a) review(a, { action: req.action });
    }
    return json({ updated: req.ids.length, failed: [] });
  }
  if (method === 'GET' && path === 'digest/latest') return json({ digest: fx.digest });

  if (path === 'categories' && method === 'GET') return json({ items: [...state.categories].sort((a, b) => a.name.localeCompare(b.name)) });
  if (path === 'categories' && method === 'POST') {
    const input = body as { name: string; description: string; search: Category['search']; backfillMonths: number };
    const now = new Date().toISOString();
    const category: Category = {
      id: `c-${Date.now()}`,
      name: input.name,
      description: input.description,
      color: CATEGORY_COLORS[state.categories.length] ?? '#898781',
      search: input.search,
      backfill: { months: input.backfillMonths, status: input.backfillMonths ? 'done' : 'none', runId: null, startedAt: now, completedAt: now, error: null },
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    state.categories.push(category);
    return json(category, 201);
  }
  if (path === 'categories/suggest-queries' && method === 'POST') {
    const { name } = body as { name: string };
    await delay(900);
    return json({
      description: `News about ${name} (demo suggestion).`,
      queries: [
        { q: `"${name}"`, lang: 'id' },
        { q: `"${name}" laba OR pendapatan`, lang: 'id' },
        { q: `"${name}" Indonesia`, lang: 'en' },
      ],
      exclude: ['prodia.com'],
    });
  }
  if (seg[0] === 'categories' && seg[1]) {
    const idx = state.categories.findIndex((c) => c.id === seg[1]);
    if (idx < 0) return json({ error: 'not_found', message: 'Category not found' }, 404);
    if (method === 'DELETE') {
      state.categories.splice(idx, 1);
      return json(null, 204);
    }
    if (method === 'PATCH') {
      const patch = body as Partial<Category>;
      state.categories[idx] = { ...state.categories[idx]!, ...patch, search: { ...state.categories[idx]!.search, ...(patch.search ?? {}) } };
      return json(state.categories[idx]);
    }
    if (method === 'POST' && seg[2] === 'backfill') return json(state.categories[idx], 202);
  }

  if (path === 'settings' && method === 'GET') return json(state.settings);
  if (path === 'settings' && method === 'PUT') {
    const u = body as Record<string, Record<string, unknown>>;
    const s = state.settings as unknown as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(u)) s[k] = { ...(s[k] ?? {}), ...v };
    return json(state.settings);
  }
  if (path === 'settings/models') return json(fx.models);
  if (path === 'settings/test-model') {
    await delay(700);
    return json({ ok: true, latencyMs: 812, output: 'OK', error: null });
  }
  if (path === 'runs') return json({ items: fx.runs });
  if (path === 'runs/daily') return json({ executionArn: 'demo' }, 202);

  if (path === 'stock/history') return json(stock((url.searchParams.get('range') as StockRange) ?? '3M'));
  if (path === 'stock/markers') return json({ items: markers(url.searchParams.get('from')) });
  if (path === 'stock/resync') return json({ started: true }, 202);
  if (path === 'stock/anomalies') {
    const cutoff = Date.now() / 1000 - 366 * 86400;
    const items = detectVolumeAnomalies(fx.dailyCandles, { minRatio: state.settings.stock.volumeRatio })
      .filter((a) => a.time >= cutoff)
      .map((a, i) => ({ ...a, notifiedAt: i % 2 ? new Date(a.time * 1000 + 10 * 3600_000).toISOString() : null }))
      .reverse();
    return json({ items, minRatio: state.settings.stock.volumeRatio, window: 20 });
  }
  if (path === 'feedback/stats') {
    return json({ total: 41 + state.decisions.length, corrections: 9 + state.decisions.filter((d) => d.changed).length });
  }

  if (path === 'telegram/link' && method === 'POST') {
    return json({ code: 'demo', deepLink: 'https://t.me/', expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }
  if (path === 'telegram/link/verify') {
    state.settings.telegram = { configured: true, linked: true, chatTitle: 'Demo Exec', linkedAt: new Date().toISOString() };
    return json({ linked: true, chatTitle: 'Demo Exec' });
  }
  if (path === 'telegram/link' && method === 'DELETE') {
    state.settings.telegram = { configured: true, linked: false, chatTitle: null, linkedAt: null };
    return json(null, 204);
  }
  if (path === 'telegram/test') return json({ sent: true });

  if (path === 'chat' && method === 'POST') return chatStream(body as Parameters<typeof chatStream>[0]);
  if (path === 'chat/conversations') return json({ items: state.conversations });
  if (seg[0] === 'chat' && seg[1] === 'conversations' && seg[2]) {
    if (method === 'DELETE') {
      state.conversations = state.conversations.filter((c) => c.id !== seg[2]);
      return json(null, 204);
    }
    const conversation = state.conversations.find((c) => c.id === seg[2]);
    return conversation ? json({ conversation, messages: state.chats.get(seg[2]) ?? [] }) : json({ error: 'not_found', message: 'Not found' }, 404);
  }
  return json({ error: 'not_found', message: `Mock has no route for ${method} ${path}` }, 404);
}

function review(
  article: Article,
  req: { action: string; categoryIds?: string[]; sentiment?: Sentiment; summary?: string; rationale?: string },
): Article {
  const tags = {
    categoryIds: req.categoryIds ?? effectiveTags(article).categoryIds,
    sentiment: req.sentiment ?? effectiveTags(article).sentiment,
    ...(req.summary ?? article.final?.summary ? { summary: req.summary ?? article.final?.summary } : {}),
    ...(req.rationale ?? article.final?.rationale ? { rationale: req.rationale ?? article.final?.rationale } : {}),
  };
  if (['approve', 'reject', 'update'].includes(req.action)) {
    state.decisions.push({ changed: req.action === 'reject' || Boolean(req.summary || req.rationale) || tags.sentiment !== article.suggestion?.sentiment });
  }
  const next: Article = { ...article, reviewedAt: new Date().toISOString() };
  if (req.action === 'approve') Object.assign(next, { status: 'APPROVED', final: tags });
  if (req.action === 'reject') next.status = 'REJECTED';
  if (req.action === 'update') next.final = tags;
  if (req.action === 'restore' || req.action === 'unsave') next.status = 'PENDING';
  state.articles = state.articles.map((a) => (a.id === article.id ? next : a));
  return next;
}

export function installMockApi(config: RuntimeConfig): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith(config.apiUrl)) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const body = typeof raw === 'string' && raw ? (JSON.parse(raw) as unknown) : undefined;
    return route(method, url, body);
  };
}
