import {
  DEFAULT_SETTINGS,
  LANGUAGE_MODELS,
  parseAssetId,
  type Article,
  type Candle,
  type Category,
  type Conversation,
  type Digest,
  type Run,
  type Sentiment,
  type SettingsView,
  type StockAsset,
  type StockSource,
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

/** The demo account follows Acme Group, a fictional regional logistics and energy company, plus a topic of its own. */
export const categories: Category[] = [
  ['c-corp', 'Acme Group', 'Corporate news about Acme Group (ACME): results, deals, leadership and plans.', '#2a78d6'],
  ['c-digital', 'Acme Digital', 'Acme’s digital services subsidiary and its delivery app.', '#eb6834'],
  ['c-ev', 'Electric vehicles', 'Electric-vehicle demand, charging networks and battery supply in Southeast Asia.', '#1baf7a'],
  ['c-reg', 'Industry regulation', 'Rules and policy affecting logistics and energy companies.', '#eda100'],
  ['c-comp', 'Competitors', 'News about Acme’s rivals in logistics and delivery.', '#e87ba4'],
].map(([id, name, description, color], i) => ({
  id: id!,
  name: name!,
  description: description!,
  color: color!,
  search: {
    enabled: true,
    queries: [{ q: `"${name}"`, edition: 'SG:en' as const }, { q: `"${name}" news`, edition: 'US:en' as const }],
    exclude: i === 0 ? ['acme.example', 'cartoon'] : [],
    sources: { googleNews: true, gdelt: true },
  },
  backfill: { months: 6, status: 'done' as const, runId: 'r-1', startedAt: iso(20 * DAY), completedAt: iso(20 * DAY - 3600_000), error: null },
  active: true,
  createdAt: iso(21 * DAY),
  updatedAt: iso(21 * DAY),
}));

const OUTLETS = ['Business Daily (demo)', 'Market Wire (demo)', 'Regional Herald (demo)', 'Policy Watch (demo)', 'Energy Report (demo)'];

const HEADLINES: [string, Sentiment, string[], string][] = [
  ['Sample: Acme Group reports higher quarterly revenue on freight demand', 'positive', ['c-corp'], 'Revenue grew on strong freight volumes; margins held steady.'],
  ['Sample: Acme opens three new distribution hubs in the region', 'positive', ['c-corp'], 'The expansion adds regional coverage and is expected to lift volumes next year.'],
  ['Sample: Acme Digital’s delivery app passes one million users', 'positive', ['c-digital'], 'The milestone supports the group’s push to grow online bookings.'],
  ['Sample: regulator reviews fuel surcharges for freight operators', 'negative', ['c-reg'], 'Lower allowed surcharges could pressure margins for logistics operators.'],
  ['Sample: Acme’s charging network signs supply deal with a city fleet', 'positive', ['c-ev'], 'The deal widens the customer base for its fast-charging services.'],
  ['Sample: competitor cuts prices on same-day delivery', 'negative', ['c-comp'], 'Aggressive pricing by a rival may weigh on volumes in key cities.'],
  ['Sample: Acme holds annual community clean-up campaign', 'neutral', ['c-corp'], 'A community campaign with no clear effect on financial performance.'],
  ['Sample: analysts keep neutral view on logistics stocks this quarter', 'neutral', ['c-corp', 'c-comp'], 'Sector outlook unchanged; valuation seen as fair.'],
  ['Sample: electric-truck sales double from a year earlier', 'positive', ['c-ev'], 'Faster adoption supports demand for charging and fleet services.'],
  ['Sample: draft rules tighten emissions reporting for fleets', 'negative', ['c-reg'], 'Compliance costs may rise, though larger operators are better placed.'],
  ['Sample: board approves cash dividend payout', 'positive', ['c-corp'], 'The payout signals confidence in cash generation.'],
  ['Sample: rival raises funding to expand its delivery network', 'negative', ['c-comp'], 'A better-funded competitor could intensify competition for contracts.'],
  ['Sample: Acme Digital partners with a bank on in-app payments', 'positive', ['c-digital'], 'The partnership opens a new revenue channel for the app.'],
  ['Sample: ministry discusses battery-recycling standards', 'undecided', ['c-reg', 'c-ev'], 'Standards are still being drafted; impact unclear.'],
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
    lang: 'en',
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
    title: `Sample: unrelated "Acme" result #${i + 1}`,
  })),
  ...Array.from({ length: 2 }, (_, i) => makeArticle(i + 10, 'REJECTED', 3 + i * 2)),
];

export const articleText = (a: Article) =>
  `${a.title}\n\nThis is fictional sample text shown in mock mode. In the deployed dashboard this panel shows the article text extracted from the publisher's page.\n\n${a.suggestion?.summary ?? ''}`;

export const digest: Digest = {
  id: new Date(now).toISOString().slice(0, 10),
  runId: 'r-2',
  runType: 'daily',
  title: '6 new items: expansion news leads, one surcharge risk',
  summary:
    'Mostly positive coverage today: new distribution hubs and a payments partnership. One item flags a possible review of fuel surcharges, which could pressure margins. (Fictional demo digest.)',
  highlights: articles
    .filter((a) => a.status === 'PENDING')
    .slice(0, 3)
    .map((a) => ({ articleId: a.id, title: a.title, sentiment: a.suggestion!.sentiment, why: 'Sample highlight explaining why this matters.' })),
  overall: { sentiment: 'positive', reason: 'The expansion and the payments partnership outweigh the surcharge risk.' },
  counts: { total: 6, positive: 2, negative: 2, neutral: 2, undecided: 0 },
  createdAt: iso(2 * 3600_000),
};

interface SampleSeries {
  daily: Candle[];
  intraday: Candle[];
}

/**
 * A random walk of sample prices. `offsetH` is the exchange's UTC offset, `open` its session
 * start (minutes); `spikes` adds an occasional volume spike so the unusual-volume list has
 * something to show.
 */
function sampleSeries(o: { start: number; swing: number; decimals: number; volume: number; everyDay: boolean; offsetH: number; open: number; bars: number; spikes?: boolean }): SampleSeries {
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
    const spike = o.spikes && daily.length % 37 === 36 ? 3.6 : 1;
    daily.push({ time: midnight(t), open, high, low, close, volume: volume(spike) });
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

const asset = (id: string, a: Pick<StockAsset, 'name' | 'exchange' | 'type' | 'currency' | 'timeZone' | 'session' | 'decimals' | 'hasVolume'>): StockAsset => {
  const { source, symbol } = parseAssetId(id)!;
  return { id, source, symbol, ...a, intradayInterval: '15m', firstTradeDate: null, updatedAt: iso(0) };
};

/** The demo offers both sources, so the Add form's source choice can be reviewed. */
export const stockSources: StockSource[] = ['yahoo', 'eodhd'];

/**
 * Sample assets: the first three are in the demo account's list; the currency, and Acme from
 * EODHD (same sample prices), can be added in Settings. ACME is a fictional listing.
 */
export const sampleAssets: StockAsset[] = [
  asset('yahoo:ACME', { name: 'Acme Group (demo)', exchange: 'Singapore', type: 'EQUITY', currency: 'SGD', timeZone: 'Asia/Singapore', session: { start: '09:00', end: '17:00', days: 'weekdays' }, decimals: 2, hasVolume: true }),
  asset('yahoo:^GSPC', { name: 'S&P 500', exchange: 'SNP', type: 'INDEX', currency: 'USD', timeZone: 'America/New_York', session: { start: '09:30', end: '16:00', days: 'weekdays' }, decimals: 2, hasVolume: false }),
  asset('yahoo:BTC-USD', { name: 'Bitcoin USD', exchange: 'CCC', type: 'CRYPTOCURRENCY', currency: 'USD', timeZone: 'UTC', session: { start: '00:00', end: '23:59', days: 'daily' }, decimals: 2, hasVolume: true }),
  asset('yahoo:EURUSD=X', { name: 'EUR/USD', exchange: 'CCY', type: 'CURRENCY', currency: 'USD', timeZone: 'Europe/London', session: { start: '00:00', end: '23:59', days: 'weekdays' }, decimals: 4, hasVolume: false }),
  asset('eodhd:ACME.SG', { name: 'Acme Group Ltd (demo)', exchange: 'SG', type: 'EQUITY', currency: 'SGD', timeZone: 'Asia/Singapore', session: { start: '09:00', end: '17:00', days: 'weekdays' }, decimals: 2, hasVolume: true }),
];

const acme = sampleSeries({ start: 4.2, swing: 0.035, decimals: 2, volume: 1_500_000, everyDay: false, offsetH: 8, open: 9 * 60, bars: 32, spikes: true });

export const sampleCandles: Record<string, SampleSeries> = {
  'yahoo:ACME': acme,
  'yahoo:^GSPC': sampleSeries({ start: 5800, swing: 0.012, decimals: 2, volume: 0, everyDay: false, offsetH: -5, open: 9 * 60 + 30, bars: 26 }),
  'yahoo:BTC-USD': sampleSeries({ start: 62_000, swing: 0.04, decimals: 2, volume: 30_000_000_000, everyDay: true, offsetH: 0, open: 0, bars: 96 }),
  'yahoo:EURUSD=X': sampleSeries({ start: 1.08, swing: 0.004, decimals: 4, volume: 0, everyDay: false, offsetH: 1, open: 0, bars: 96 }),
  'eodhd:ACME.SG': acme,
};

export const settings: SettingsView = {
  ...DEFAULT_SETTINGS,
  stock: { ...DEFAULT_SETTINGS.stock, assets: ['yahoo:ACME', 'yahoo:^GSPC', 'yahoo:BTC-USD'] },
  profile: {
    subject: 'Acme Group',
    context: `A fictional regional logistics and energy group, used for this demo. Acme Digital is its digital services subsidiary; Acme also runs a fast-charging network for electric fleets.

Not related, despite the name: other companies called Acme, and cartoon references.`,
    sentimentAsset: 'yahoo:ACME',
  },
  updatedAt: null,
  embedding: { model: 'google:gemini-embedding-2', dimensions: 768 },
  telegram: { configured: true, linked: false, chatTitle: null, linkedAt: null },
  configuredProviders: ['anthropic', 'google'],
  stage: 'demo',
  region: 'ap-southeast-1',
};

/** A brand-new account (mock mode with `?blank`): the defaults, nothing set up yet. */
export const blankSettings: SettingsView = { ...settings, stock: DEFAULT_SETTINGS.stock, profile: DEFAULT_SETTINGS.profile };

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
