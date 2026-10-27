# Architecture

One CDK stack per stage (`BioMajesty-<stage>`), all serverless.

```
User ─HTTPS─> CloudFront ─OAC─> S3 (React SPA + config.json written by CDK)
  │ Cognito managed login (OAuth code + PKCE, optional TOTP MFA)
  └─ID token─> API Gateway REST (regional, Cognito authorizer on every route, gzip ≥ 1 KB)
                 ├─ Lambda ApiNews / ApiCategories / ApiSettings / ApiStock / ApiTelegram / ApiChatHistory
                 └─ Lambda ApiChatStream (response streaming, 15 min) ─> LLM via AI SDK ─> tools
EventBridge Scheduler, every 15 min (timeZone)
  ├─ Lambda NewsDispatch: for each member of dashboard-users whose daily-run time is now ─> Step Functions "Daily" { sub }
  └─ Lambda StockIngest: every asset any account tracks (each from its own source), when its market is open / its end-of-day pass is due (+ volume checks per account)
New category / "Backfill" ─> Step Functions "Backfill" { sub }
DynamoDB stream (accounts' article items) ─> Lambda Indexer ─> embeddings ─> S3 Vectors
SSM Parameter Store: provider API keys + Telegram bot token (SecureString).   CloudWatch alarms ─> SNS (alarmEmail)
```

## Accounts

Every member of the Cognito group `dashboard-users` is an account (its Cognito `sub`), with its own profile, categories, settings, review queue, saved news, digests, runs, review decisions, chats, volume alerts and Telegram chat. API handlers take the account from the token (`(event, user)` in `backend/src/lib/router.ts`), never from the request, and every repository function takes the account first. Background jobs list the accounts with `ListUsersInGroup` (`backend/src/lib/accounts.ts`), so removing someone from the group also stops their runs and price refreshes. Shared: market data per asset (public), the API keys parameter, the Telegram bot.

## Time zones

- **The dashboard's clock**: `timeZone` in `backend/cdk.json` (default `Asia/Singapore`), passed to the Lambdas as `TIME_ZONE` and to the SPA in `config.json`. Each account's daily-run time is a quarter hour on this clock; it also sets every time the dashboard shows, "today" in chat, news date filters (a `YYYY-MM-DD` is a day in this zone) and the digest's date.
- **The markets' clocks**: each asset's exchange time zone (from its source: Yahoo's chart metadata or EODHD's exchange details; `Asia/Jakarta` for IDX, `America/New_York` for US listings, `UTC` for crypto…). It sets the asset's trading session, trading dates, daily candles and volume anomalies.

## Pipelines (Step Functions)

Both state machines share the same steps (`backend/src/handlers/pipeline.ts`, logic in `src/pipeline/`). Every execution belongs to one account (`sub` in the state) and uses only its categories, settings, profile and dedupe keys:

1. **start** — create the run record and the search tasks (one per Google News query, in the query's edition: country and language, `EDITIONS` in `shared/src/editions.ts`; GDELT, which has no editions, gets each category's query once, batched into sequential tasks to respect its rate limit). Daily window: since the account's last successful run, between 24 hours and 7 days. Backfill: date windows of 7/14/30 days depending on the period.
2. **search** (Map, concurrency 2–3) — fetch results, store raw hits in S3. A failing query is skipped, not fatal.
3. **collect** — merge duplicates across queries/providers (URL, Google News id, headline + outlet) and drop anything the account already knows (its alias items in DynamoDB).
4. **prefilter** — the LLM screens headlines in batches of 50 against the account's profile; obvious noise is stored as `FILTERED` (restorable for 30 days), the rest becomes one S3 item per candidate.
5. **enrich** (Distributed Map, concurrency 4) — decode Google News links, fetch + extract the article (Readability, SSRF-guarded), tag it with the LLM (sentiment per the account's profile, optionally with its recent corrections as examples), store it as `PENDING`.
6. **digest** — LLM summary and overall sentiment of what the run found → DynamoDB → the account's Telegram chat (summary, overall sentiment, item counts and a button to the review queue).
7. **finish** — aggregate token usage, mark the run succeeded; for backfills, activate the category. Any failure → **fail** step: mark the run failed and alert on Telegram.

**Dedupe keys and deletes:** an article's alias items (URL, Google News id, headline + outlet) keep later runs from adding it again, and the article records their ids (`aliasIds`). Deleting from the recycle bin (`REJECTED`) deletes the article and its alias items, so a later run or backfill can find it again. Deleting from *Filtered by AI* is a soft delete (`deletedAt`, GSI1 keys removed): hidden from the list and counts, alias items kept, so later runs keep filtering it out.

## Data model (DynamoDB single table)

Keys `PK`/`SK`, index `GSI1` (`GSI1PK`/`GSI1SK`), TTL attribute `expiresAt`, stream `NEW_AND_OLD_IMAGES`.

Everything an account owns lives in its partition `USER#<sub>`; market data is shared per asset. Assets are named by an ID, `<source>:<symbol>` with the symbol in the source's own format (`yahoo:D05.SI`, `eodhd:AAPL.US`; `assetId` in `shared/src/stock.ts`).

| Item | PK / SK | Notes |
|---|---|---|
| Article | `USER#<sub>` / `ART#<id>` | `suggestion` (AI), `final` (reviewer: tags, sentiment, edited summary/reason), status `PENDING/APPROVED/REJECTED/FILTERED`, `aliasIds`, `deletedAt` (soft-deleted filtered). GSI1 = `USER#<sub>#STATUS#<status>` / `<publishedAt>#<id>` |
| Alias | `USER#<sub>` / `ALIAS#<url\|gnews\|title>#<hash>` | De-duplication (`articleId`); deleted with a recycle-bin article, kept for a filtered one |
| Category | `USER#<sub>` / `CATEGORY#<id>` | Queries (each with its Google News edition), exclusions, sources, backfill status |
| Settings | `USER#<sub>` / `SETTINGS` | Profile (incl. the sentiment asset), assets (`stock.assets`: asset IDs), models, schedule, sources, notifications, learning |
| Telegram link | `USER#<sub>` / `TELEGRAM` | The account's chat; the bot's getUpdates offset is `TELEGRAM` / `BOT` |
| Run | `USER#<sub>` / `RUN#<runId>` (time-sortable) | Stats (atomic counters), usage, error |
| Digest | `USER#<sub>` / `DIGEST#<createdAt>#<id>` | Latest = newest |
| Feedback | `USER#<sub>` / `FEEDBACK#<decidedAt>#<articleId>` | Training data: AI suggestion, reviewer's decision, changed fields |
| Volume alert | `USER#<sub>` / `ANOMALY#<asset ID>#<date>` | Notified anomalies (each account has its own threshold) |
| Conversation | `USER#<sub>` / `CHAT#<id>` | Chat list; transcripts in S3 |
| Run item | `RUNITEM#<runId>` / `<articleId>` | Articles a run produced (digest input), TTL 60 days |
| Run usage | `RUNUSAGE#<runId>` / random | Token usage per step (race-free), folded into the run at the end |
| Stock | `STOCK#<asset ID>` / `D#<date>`, `I#<epoch>` (15-min bars, TTL 10 days), `QUOTE`, `STATUS`, `META` | Candles, latest quote, refresh status (`eodDoneFor`), asset metadata (ID, source, symbol, name, exchange, type, time zone, session, intraday interval, decimals, volume) |
| Telegram link code | `TGLINK#<code>` / `TGLINK` | One-time link codes (TTL), `linkedChatTitle` once seen |

**S3 data bucket:** `users/<sub>/articles/<id>.json` (extracted text), `raw/<runId>/…` and `runs/<runId>/…` (pipeline scratch, 90-day lifecycle), `chats/<sub>/<id>.json`.

**S3 Vectors index** `articles-<embedding-model>-<dims>`: one vector per chunk (`<sub>#<articleId>#<n>`; chunk 0 = headline + effective summary). Filterable metadata: `owner` (the account; every query filters on it), `articleId`, `publishedAt`, `categoryIds`, `sentiment`; non-filterable: `title`, `text`, `source`. Only `APPROVED` articles are indexed; edits re-index, un-saving removes the vectors.

**Market data:** the stock refresh (`backend/src/handlers/stock-ingest.ts`) runs every 15 minutes for the union of all accounts' assets, each through its source's provider (`backend/src/stock/`: `yahoo.ts`, `eodhd.ts`, picked by `stockProvider(source)`; `STOCK_SOURCE_INFO` in `shared/src/stock.ts` describes each source's symbol format and timing). Each asset's session pattern (local start/end, weekdays or every day) comes from its source and decides when it is polled (`backend/src/stock/session.ts`): while open, the latest intraday bars and quote (only the quote for EODHD, whose bars arrive after the close); one end-of-day pass once the source has settled the day (an hour after the close for Yahoo, three for EODHD). 15-minute bars expire after 10 days; the intraday CSV download asks the source instead (Yahoo: 60 days, EODHD: 120). Sources other than Yahoo are offered once their API key is in the API keys parameter (`configuredSources`).

## API (all routes Cognito-authorized)

| Area | Routes |
|---|---|
| News | `GET /news`, `GET /news/counts`, `GET\|PATCH /news/{id}`, `POST /news/bulk`, `POST /news/delete`, `GET /digest/latest`, `GET /feedback/stats` |
| Categories | `GET\|POST /categories`, `PATCH\|DELETE /categories/{id}`, `POST /categories/{id}/backfill`, `POST /categories/suggest-queries` |
| Settings | `GET\|PUT /settings`, `GET /settings/models`, `POST /settings/test-model`, `GET /runs`, `POST /runs/daily` |
| Stock | `GET\|POST /stock/assets` (add: `{source, symbol}`; the list includes the usable sources), `DELETE /stock/assets?asset=`, `GET /stock/search?source=&q=` (symbols matching a name or ticker), `GET /stock/history?asset=&range=`, `GET /stock/export?asset=&interval=1d\|intraday` (stored daily bars, or the source's recent intraday bars, as CSV), `GET /stock/anomalies?asset=&from=`, `POST /stock/resync` |
| Telegram | `POST\|DELETE /telegram/link`, `POST /telegram/link/verify`, `POST /telegram/test` |
| Chat | `POST /chat` (AI SDK UI message stream), `GET /chat/conversations`, `GET\|DELETE /chat/conversations/{id}` |

## Security

- No public sign-up; Cognito authorizer on every non-preflight method (asserted in `backend/test/stack.test.ts`).
- Only members of the Cognito group `dashboard-users` can use the API (checked in the router and the chat stream); optional Google sign-in (`googleClientId`) creates users for any Google account, so the group is what grants access.
- Accounts are isolated: every item and object is keyed by the caller's `sub` from the ID token, the chat's vector search always filters on `owner`, and stock routes only serve the caller's own assets.
- Least-privilege grants per Lambda; private, encrypted buckets behind CloudFront OAC.
- Article text is treated as untrusted (delimited in prompts, structured output); chat tools are read-only.
- The article fetcher blocks private, loopback, link-local and metadata addresses on every redirect hop.
- cdk-nag (AwsSolutions) runs on every synth; accepted findings are listed with reasons in `backend/lib/nag.ts`.
