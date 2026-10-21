import {
  DEFAULT_SETTINGS,
  LANGUAGE_MODELS,
  type Article,
  type Candle,
  type Category,
  type Conversation,
  type Digest,
  type Run,
  type Sentiment,
  type SettingsView,
  type StockAsset,
} from '@bio-majesty/shared';

/**
 * FICTIONAL sample data for mock mode (npm run dev:mock). Headlines, outlets
 * and prices are invented for UI review and are not real news or quotes.
 */

let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const DAY = 86_400_000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

export const categories: Category[] = [
  ['c-corp', 'Prodia Widyahusada', 'Corporate news about PT Prodia Widyahusada Tbk (PRDA).', '#2a78d6'],
  ['c-digital', 'Prodia Digital Indonesia', 'The digital health subsidiary.', '#eb6834'],
  ['c-proline', 'Proline', 'PT Prodia Diagnostic Line: reagents and diagnostic supplies.', '#1baf7a'],
  ['c-reg', 'Healthcare regulation', 'Indonesian policy affecting clinical laboratories.', '#eda100'],
  ['c-comp', 'Competitors', 'Competing laboratory chains.', '#e87ba4'],
].map(([id, name, description, color], i) => ({
  id: id!,
  name: name!,
  description: description!,
  color: color!,
  search: {
    enabled: true,
    queries: [{ q: `"${name}"`, lang: 'id' as const }, { q: `"${name}" news`, lang: 'en' as const }],
    exclude: i === 0 ? ['prodia.com'] : [],
    sources: { googleNews: true, gdelt: true },
  },
  backfill: { months: 6, status: 'done' as const, runId: 'r-1', startedAt: iso(20 * DAY), completedAt: iso(20 * DAY - 3600_000), error: null },
  active: true,
  createdAt: iso(21 * DAY),
  updatedAt: iso(21 * DAY),
}));

const OUTLETS = ['Kabar Bisnis (demo)', 'Pasar Hari Ini (demo)', 'Warta Emiten (demo)', 'Health Policy Daily (demo)', 'Jakarta Market Wire (demo)'];

const HEADLINES: [string, Sentiment, string[], string][] = [
  ['Sample: lab chain reports higher quarterly revenue on health-check demand', 'positive', ['c-corp'], 'Revenue grew on strong corporate health-check volumes; margins held steady.'],
  ['Sample: company announces new clinic openings in three provinces', 'positive', ['c-corp'], 'The expansion adds regional coverage and is expected to lift testing volumes next year.'],
  ['Sample: digital health app passes one million users', 'positive', ['c-digital'], 'The app milestone supports the group’s push to grow online test bookings.'],
  ['Sample: ministry reviews tariffs for insurance-covered lab tests', 'negative', ['c-reg'], 'Lower reimbursement tariffs could pressure margins for laboratory operators.'],
  ['Sample: reagent supplier signs distribution deal with hospital group', 'positive', ['c-proline'], 'The deal widens the associate’s customer base for diagnostic supplies.'],
  ['Sample: competitor cuts prices on routine blood panels', 'negative', ['c-comp'], 'Aggressive pricing by a rival chain may weigh on volumes in key cities.'],
  ['Sample: company holds annual health awareness campaign', 'neutral', ['c-corp'], 'A community campaign with no clear effect on financial performance.'],
  ['Sample: analysts keep neutral view on healthcare stocks this quarter', 'neutral', ['c-corp', 'c-comp'], 'Sector outlook unchanged; valuation seen as fair.'],
  ['Sample: new genomic testing service launched for corporate clients', 'positive', ['c-corp'], 'Higher-margin specialty testing could improve the revenue mix.'],
  ['Sample: draft regulation tightens lab accreditation requirements', 'negative', ['c-reg'], 'Compliance costs may rise, though larger operators are better placed.'],
  ['Sample: board approves cash dividend payout', 'positive', ['c-corp'], 'The payout signals confidence in cash generation.'],
  ['Sample: rival chain raises funding to expand diagnostic network', 'negative', ['c-comp'], 'A better-funded competitor could intensify competition for corporate contracts.'],
  ['Sample: digital subsidiary partners with insurer on home testing', 'positive', ['c-digital'], 'The partnership opens a new channel for home sample collection.'],
  ['Sample: health ministry discusses lab data integration platform', 'undecided', ['c-reg', 'c-digital'], 'Integration requirements are still being drafted; impact unclear.'],
];

function makeArticle(i: number, status: Article['status'], daysAgo: number): Article {
  const [title, sentiment, cats, summary] = HEADLINES[i % HEADLINES.length]!;
  const id = `a-${status.toLowerCase()}-${i}`;
  return {
    id,
    url: `https://example.com/demo/${id}`,
    sourceUrl: null,
    title,
    sourceName: OUTLETS[i % OUTLETS.length]!,
    sourceDomain: 'example.com',
    publishedAt: iso(daysAgo * DAY + Math.floor(rand() * 8) * 3600_000),
    lang: i % 3 === 0 ? 'en' : 'id',
    snippet: null,
    textStatus: i % 5 === 4 ? 'paywalled' : 'ok',
    status,
    suggestion: {
      categoryIds: cats,
      sentiment,
      rationale: `${summary} (Sample rationale.)`,
      confidence: 0.55 + rand() * 0.4,
      relevance: 0.5 + rand() * 0.5,
      summary: `${summary} This is fictional sample text for the demo.`,
      model: 'anthropic:claude-opus-5-5',
    },
    final: status === 'APPROVED' ? { categoryIds: cats, sentiment } : null,
    filterReason: status === 'FILTERED' ? 'About an unrelated company with a similar name' : null,
    origin: { type: daysAgo > 12 ? 'backfill' : 'daily', runId: daysAgo > 12 ? 'r-1' : 'r-2', categoryId: cats[0] ?? null },
    foundBy: [{ provider: 'gnews', query: `"${categories[0]!.name}"` }],
    createdAt: iso(Math.min(daysAgo, 1) * DAY),
    reviewedAt: status === 'APPROVED' || status === 'REJECTED' ? iso(daysAgo * DAY - 3600_000) : null,
    indexedAt: status === 'APPROVED' ? iso(daysAgo * DAY - 3500_000) : null,
  };
}

export const articles: Article[] = [
  ...Array.from({ length: 26 }, (_, i) => makeArticle(i, 'APPROVED', 2 + i * 4)),
  ...Array.from({ length: 6 }, (_, i) => makeArticle(i + 3, 'PENDING', i % 2)),
  ...Array.from({ length: 3 }, (_, i) => ({
    ...makeArticle(i, 'FILTERED', 1),
    title: `Sample: unrelated "Prodia" result #${i + 1}`,
  })),
  ...Array.from({ length: 2 }, (_, i) => makeArticle(i + 10, 'REJECTED', 3 + i * 2)),
];

export const articleText = (a: Article) =>
  `${a.title}\n\nThis is fictional sample text shown in mock mode. In the deployed dashboard this panel shows the article text extracted from the publisher's page.\n\n${a.suggestion?.summary ?? ''}`;

export const digest: Digest = {
  id: new Date(now).toISOString().slice(0, 10),
  runId: 'r-2',
  runType: 'daily',
  title: '6 new items: expansion news leads, one tariff risk',
  summary:
    'Mostly positive coverage today: clinic expansion and a new digital partnership. One item flags a possible review of tariffs for insurance-covered tests, which could pressure margins. (Fictional demo digest.)',
  highlights: articles
    .filter((a) => a.status === 'PENDING')
    .slice(0, 3)
    .map((a) => ({ articleId: a.id, title: a.title, sentiment: a.suggestion!.sentiment, why: 'Sample highlight explaining why this matters.' })),
  counts: { total: 6, positive: 2, negative: 2, neutral: 2, undecided: 0 },
  createdAt: iso(2 * 3600_000),
};

function jakartaMidnightUtc(ms: number): number {
  const d = new Date(ms + 7 * 3600_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

/** Synthetic random-walk prices (weekdays only). */
export const dailyCandles: Candle[] = (() => {
  const out: Candle[] = [];
  let price = 2600;
  let session = 0;
  for (let d = 1200; d >= 0; d--) {
    const t = now - d * DAY;
    const day = new Date(t + 7 * 3600_000).getUTCDay();
    if (day === 0 || day === 6) continue;
    const open = price;
    const close = Math.max(1500, Math.round(open * (1 + (rand() - 0.485) * 0.035)));
    const high = Math.round(Math.max(open, close) * (1 + rand() * 0.012));
    const low = Math.round(Math.min(open, close) * (1 - rand() * 0.012));
    session++;
    // Occasional volume spikes so the unusual-volume list has something to show.
    const spike = session % 37 === 0 ? 3.6 : 1;
    out.push({ time: jakartaMidnightUtc(t), open, high, low, close, volume: Math.round((300_000 + rand() * 2_200_000) * spike) });
    price = close;
  }
  return out;
})();

export const intradayCandles: Candle[] = (() => {
  const out: Candle[] = [];
  const last = dailyCandles[dailyCandles.length - 1]!;
  let price = last.open;
  for (const dayOffset of [1, 0]) {
    const base = (jakartaMidnightUtc(now - dayOffset * DAY) - 7 * 3600) * 1000; // 00:00 WIB
    for (let slot = 0; slot < 26; slot++) {
      const t = base + (9 * 60 + slot * 15) * 60_000;
      if (t > now) break;
      const open = price;
      const close = Math.round(open * (1 + (rand() - 0.49) * 0.006));
      out.push({
        time: Math.floor(t / 1000),
        open,
        high: Math.round(Math.max(open, close) * 1.002),
        low: Math.round(Math.min(open, close) * 0.998),
        close,
        volume: Math.round(10_000 + rand() * 90_000),
      });
      price = close;
    }
  }
  return out;
})();

interface SampleSeries {
  daily: Candle[];
  intraday: Candle[];
}

/**
 * A random walk for the other sample assets, generated after PRDA's so its numbers stay
 * the same. `offsetH` is the exchange's UTC offset, `open` its session start (minutes).
 */
function sampleSeries(o: { start: number; swing: number; decimals: number; volume: number; everyDay: boolean; offsetH: number; open: number; bars: number }): SampleSeries {
  const round = (n: number) => Number(n.toFixed(o.decimals));
  const midnight = (ms: number) => {
    const d = new Date(ms + o.offsetH * 3600_000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  };
  const volume = (scale: number) => (o.volume ? Math.round(o.volume * scale * (0.4 + rand())) : 0);
  const daily: Candle[] = [];
  let price = o.start;
  for (let d = 1200; d >= 0; d--) {
    const t = now - d * DAY;
    const weekday = new Date(t + o.offsetH * 3600_000).getUTCDay();
    if (!o.everyDay && (weekday === 0 || weekday === 6)) continue;
    const open = price;
    const close = round(open * (1 + (rand() - 0.49) * o.swing));
    const high = round(Math.max(open, close) * (1 + (rand() * o.swing) / 3));
    const low = round(Math.min(open, close) * (1 - (rand() * o.swing) / 3));
    daily.push({ time: midnight(t), open, high, low, close, volume: volume(1) });
    price = close;
  }
  const intraday: Candle[] = [];
  price = daily[daily.length - 1]!.open;
  for (const dayOffset of [1, 0]) {
    const base = (midnight(now - dayOffset * DAY) - o.offsetH * 3600) * 1000; // local midnight
    for (let slot = 0; slot < o.bars; slot++) {
      const t = base + (o.open + slot * 15) * 60_000;
      if (t > now) break;
      const open = price;
      const close = round(open * (1 + ((rand() - 0.49) * o.swing) / 6));
      intraday.push({ time: Math.floor(t / 1000), open, high: round(Math.max(open, close) * 1.001), low: round(Math.min(open, close) * 0.999), close, volume: volume(1 / 40) });
      price = close;
    }
  }
  return { daily, intraday };
}

const asset = (a: Pick<StockAsset, 'symbol' | 'name' | 'exchange' | 'type' | 'currency' | 'timeZone' | 'session' | 'decimals' | 'hasVolume'>): StockAsset => ({
  ...a,
  intradayInterval: '15m',
  firstTradeDate: null,
  updatedAt: iso(0),
});

/** Sample assets: the first three are in the demo account's list, the currency can be added in Settings. */
export const sampleAssets: StockAsset[] = [
  asset({ symbol: 'PRDA.JK', name: 'PT Prodia Widyahusada Tbk', exchange: 'Jakarta', type: 'EQUITY', currency: 'IDR', timeZone: 'Asia/Jakarta', session: { start: '09:00', end: '16:15', days: 'weekdays' }, decimals: 0, hasVolume: true }),
  asset({ symbol: '^JKSE', name: 'IDX Composite', exchange: 'Jakarta', type: 'INDEX', currency: 'IDR', timeZone: 'Asia/Jakarta', session: { start: '09:00', end: '16:15', days: 'weekdays' }, decimals: 2, hasVolume: false }),
  asset({ symbol: 'BTC-USD', name: 'Bitcoin USD', exchange: 'CCC', type: 'CRYPTOCURRENCY', currency: 'USD', timeZone: 'UTC', session: { start: '00:00', end: '23:59', days: 'daily' }, decimals: 2, hasVolume: true }),
  asset({ symbol: 'USDIDR=X', name: 'USD/IDR', exchange: 'CCY', type: 'CURRENCY', currency: 'IDR', timeZone: 'Europe/London', session: { start: '00:00', end: '23:59', days: 'weekdays' }, decimals: 4, hasVolume: false }),
];

export const sampleCandles: Record<string, SampleSeries> = {
  'PRDA.JK': { daily: dailyCandles, intraday: intradayCandles },
  '^JKSE': sampleSeries({ start: 7100, swing: 0.012, decimals: 2, volume: 0, everyDay: false, offsetH: 7, open: 9 * 60, bars: 26 }),
  'BTC-USD': sampleSeries({ start: 62_000, swing: 0.04, decimals: 2, volume: 30_000_000_000, everyDay: true, offsetH: 0, open: 0, bars: 96 }),
  'USDIDR=X': sampleSeries({ start: 16_100, swing: 0.004, decimals: 4, volume: 0, everyDay: false, offsetH: 1, open: 0, bars: 96 }),
};

export const settings: SettingsView = {
  ...DEFAULT_SETTINGS,
  stock: { ...DEFAULT_SETTINGS.stock, symbols: ['PRDA.JK', '^JKSE', 'BTC-USD'] },
  updatedAt: null,
  embedding: { model: 'google:gemini-embedding-2', dimensions: 768 },
  telegram: { configured: true, linked: false, chatTitle: null, linkedAt: null },
  configuredProviders: ['anthropic', 'google'],
  stage: 'demo',
  region: 'ap-southeast-1',
};

export const models = {
  configuredProviders: settings.configuredProviders,
  models: LANGUAGE_MODELS.map((m) => ({ ...m, available: settings.configuredProviders.includes(m.provider) })),
};

export const runs: Run[] = [
  {
    id: 'r-2',
    type: 'daily',
    status: 'succeeded',
    categoryId: null,
    window: { from: iso(DAY + 2 * 3600_000), to: iso(2 * 3600_000) },
    startedAt: iso(2 * 3600_000 + 600_000),
    finishedAt: iso(2 * 3600_000),
    stats: { searched: 12, found: 48, duplicates: 30, filtered: 12, pending: 6, errors: 0 },
    usage: [
      { task: 'prefilter', model: 'anthropic:claude-opus-5-5', calls: 1, inputTokens: 6200, outputTokens: 1800 },
      { task: 'tagging', model: 'anthropic:claude-opus-5-5', calls: 6, inputTokens: 31000, outputTokens: 4100 },
    ],
    error: null,
    trigger: 'schedule',
  },
  {
    id: 'r-1',
    type: 'backfill',
    status: 'succeeded',
    categoryId: 'c-corp',
    window: { from: iso(200 * DAY), to: iso(20 * DAY) },
    startedAt: iso(20 * DAY),
    finishedAt: iso(20 * DAY - 3600_000),
    stats: { searched: 52, found: 610, duplicates: 280, filtered: 190, pending: 140, errors: 1 },
    usage: [{ task: 'tagging', model: 'anthropic:claude-opus-5-5', calls: 140, inputTokens: 520000, outputTokens: 88000 }],
    error: null,
    trigger: 'category',
  },
];

export const conversations: Conversation[] = [];
