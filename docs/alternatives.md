# Paid alternatives to the free data sources

The dashboard uses free/unofficial sources by default. If one becomes unreliable, these are the documented upgrades (prices as researched in October 2026 — check the vendor before buying).

## News discovery

| Option | Price | Why / when | Integration |
|---|---|---|---|
| **Serper** (Google search & news results) | $50 per 50k queries (~$1/1k), 2,500 free; validity 6 months | Same Google News coverage with direct publisher URLs (no redirect decoding), date ranges, country/language | New source adapter next to `backend/src/sources/google-news-rss.ts` |
| **Claude web search tool** | $10 per 1,000 searches + tokens (Claude API / Claude Platform on AWS; not Bedrock) | Agentic "deep search" for backfills — the model chooses queries and reads pages | An optional enrich/backfill step using `web_search_20260209` |
| **Exa** | ~$7 per 1,000 searches with contents | Semantic search with published-date filters | Source adapter |
| **NewsData.io** | from $199.99/mo (6-month archive), $349.99/mo (2 years) | Structured news archive with multi-year history | Source adapter |
| **Brave Search API** (news endpoint) | ~$5 per 1,000 requests | Independent index, freshness filters | Source adapter |

Not an option: the **Google Custom Search JSON API** is closed to new customers and is discontinued on 1 January 2027.

## Stock data

Each asset picks its source when it is added (**Settings → Assets**). The research below (21 October 2026) tested whether a source has **daily and 15-minute bars for an IDX listing** (the first deployment's market) and whether a company may use it; for other markets, check each vendor's coverage first.

| Option | Price | IDX listing | Notes | Integration |
|---|---|---|---|---|
| **EODHD** | $29.99/mo for the personal plan with intraday data ($19.99 is end-of-day only); commercial *Internal use* $399/mo | Daily since listing (verified, data current to 13 Oct 2026); 5-minute bars since Oct 2020, finalized 2–3 hours after the close | Also SGX, US, indices, FX, crypto. The self-serve plans are for personal use; *Internal use* allows use "only inside your company" (1 seat: ask how a staff dashboard counts). During the session EODHD assets show only their quote | Implemented: add `EODHD_API_KEY` to the API keys parameter, then add assets from EODHD in **Settings → Assets** (symbols like `AAPL.US`, `VOD.LSE`) |
| **Invezgo** (Indonesian) | Rp 499,900 / 999,000 / 1,999,900 / 4,000,000 (Advance, Prime, Max, Elite; promotional prices, billing period not stated); free tier | Intraday endpoints, updated every 5 seconds; history back to 2009 (its claim) | IDX only (900+ stocks, IHSG, LQ45, IDX30). The only cheap source found that claims live IDX intraday. Check its terms and bar intervals with a free key first | New provider (below) |
| **GoAPI** (Indonesian) | Behind its login; free trial | Prices and history; intraday not stated | IDX only; also company profiles and technical indicators | New provider |
| **Sectors.app** | $59/mo (*Insider*: API with 5,000 credits a month; the $49 plan has no API) | End-of-day close, volume and market cap; no intraday | IDX, SGX, Bursa Malaysia. Strong on fundamentals, broker and foreign flow, filings: a complement for the chat rather than a price source | Chat tool or enrichment, not a provider |
| **Financial Modeling Prep** | About $149/mo for global coverage (annual billing; third-party figure, FMP's page blocked the check) | `.JK` symbols listed; intraday not confirmed | Displaying the data needs a separate licence | New provider, if a test shows IDX intraday |
| **Twelve Data** | $229/mo (*Pro*), the cheapest plan with IDX | End of day only | The individual plans are personal/internal and non-commercial | Not a fit |
| **Finnhub** | $3,500/mo (*All-in-One*) | End of day only (outside TSX, LSE, Euronext and Deutsche Börse) | | Not a fit |
| **TradingView widget** | free embed | Display only | No data for markers, alerts or the chat | Not recommended |

No IDX intraday at all: **Alpha Vantage** ($49.99–249.99/mo; Indonesia isn't among the exchanges its docs show), **Marketstack** ($9.99–149.99/mo; intraday is US-only) and the US-focused **Massive** (formerly Polygon), **Alpaca** and **Tiingo**. They're fine for US assets.

**Free:** Google Finance (`GOOGLEFINANCE` in Google Sheets: IDX quotes 10 minutes delayed and daily history, but no API, and Google's terms forbid commercial use without written consent); the IDX website (official daily stock summary; its data endpoints aren't public and are hard to call from Lambda); EODHD's free tier (20 calls a day, one year of daily bars).

**Enterprise** (price on request, typically tens of thousands of dollars a year): ICE Data Services (lists IDX feeds), LSEG, Bloomberg (a Terminal seat can't feed a web app; B-PIPE can), FactSet, S&P Capital IQ, or a data licence from IDX itself. Worth asking the company's investor-relations or finance team what it already licenses.

**Adding a source:** implement `StockProvider` (`backend/src/stock/provider.ts`: lookup, search, daily, intraday, quote) next to `yahoo.ts` and `eodhd.ts`; add the source to `STOCK_SOURCES` and `STOCK_SOURCE_INFO` in `shared/src/stock.ts` (symbol format, examples, whether intraday bars arrive live or after the close, how long it takes to settle the day, how many days of intraday it serves), and to `PROVIDERS` and `SOURCE_SECRET_KEYS` in `backend/src/stock/index.ts`; put its API key in `KNOWN_KEYS` (`backend/src/lib/secrets.ts`) and in the README's API keys example. It then appears in the Add form once its key is in the secret.

## AI hosting (future agents)

Not needed today — all LLM work runs on Lambda + Step Functions. If long-running agents are added later:

- **Claude Platform on AWS** — same Claude API (incl. web search, batches) with IAM auth and AWS Marketplace billing; a client swap in `backend/src/ai/registry.ts`.
- **Amazon Bedrock AgentCore Runtime** — AWS-native agent hosting, sessions up to 8 hours.
- **Claude Managed Agents** (beta) — Anthropic runs the agent loop and sandbox, including scheduled runs.
- **Claude Agent SDK** on ECS Fargate / AgentCore — a Claude Code-style research agent.
- An **MCP endpoint** over `backend/src/tools/news-tools.ts` would let Claude Code, Claude Desktop and other MCP clients query the saved news directly.
