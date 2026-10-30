# Architecture

One CDK stack per stage (dev `BioMajesty-dev`, prod `news-accumulator`), all serverless.

```
User ─HTTPS─> CloudFront ─OAC─> S3 (React SPA + config.json written by CDK)
  │ Cognito managed login (OAuth code + PKCE, optional TOTP MFA)
  └─ID token (+ X-Profile-Id header)─> API Gateway REST (regional, Cognito authorizer on every route, gzip ≥ 1 KB)
                 ├─ Lambda ApiNews / ApiCategories / ApiSettings / ApiStock / ApiTelegram / ApiChatHistory / ApiProfiles / ApiAdmin
                 └─ Lambda ApiChatStream (response streaming, 15 min) ─> LLM via AI SDK ─> tools
EventBridge Scheduler
  ├─ schedule group <prefix>-<stage>-daily-runs: one schedule per profile, at its run time + its offset (timeZone) ─> Step Functions "Daily" { profileId }
  └─ every 15 min: Lambda StockIngest: every asset any profile tracks (each from its own source), when its market is open / its end-of-day pass is due (+ volume checks per profile)
New category / "Backfill" ─> Step Functions "Backfill" { profileId }
Delete profile / delete user ─> Lambda DeleteWorker (async, 15 min, continues in a new invocation)
DynamoDB stream (profiles' article items) ─> Lambda Indexer ─> embeddings ─> S3 Vectors
SSM Parameter Store: provider API keys + Telegram bot token (SecureString).   CloudWatch alarms ─> SNS (alarmEmail)
```

## Accounts and profiles

Every member of the Cognito group `dashboard-users` is an account (its Cognito `sub`). An account has one or more profiles, and everything the dashboard shows belongs to a profile: its subject, categories, settings, review queue, saved news, digests, runs, review decisions, chats, volume alerts and Telegram connections. Whoever signs in to the account can use all of its profiles (no roles per profile). Shared across profiles: market data per asset (public), the API keys parameter, the Telegram bot.

- The SPA sends the open profile in an `X-Profile-Id` header. The router (`backend/src/lib/router.ts`, via `resolveProfile` in `src/lib/profile-access.ts`) and the chat stream check that it is one of the signed-in account's profiles; another account's profile gets the same 404 as a missing one. Handlers get `(event, user)` with `user.profileId`, and every repository function takes the profile first. `ProfileId` is a branded type, so a Cognito `sub` can't be passed where a profile is meant.
- `/profiles` is account-level (no header): list, add, rename, delete. A new profile gets its daily-run schedule at once. Deleting refuses the account's last profile and a profile whose run is in progress, deletes the schedule, takes the profile off the account's list, and leaves the data to `DeleteWorker`.
- The SPA keeps one query cache per profile, so switching starts afresh, and remembers the last profile per browser. A `?profile=<id>` link (the Telegram buttons) opens that profile.
- Background jobs list the accounts with `ListUsersInGroup` (`backend/src/lib/accounts.ts`), so removing someone from the group also stops their price refreshes and volume alerts. A scheduled run checks that its profile's account still has access, and otherwise ends after its first step without a run record.

## Time zones

- **The dashboard's clock**: `timeZone` in `backend/cdk.json` (default `Asia/Singapore`), passed to the Lambdas as `TIME_ZONE` and to the SPA in `config.json`. Each profile's daily-run time is a quarter hour on this clock (its schedule stores the zone when it is written); it also sets every time the dashboard shows, "today" in chat, news date filters (a `YYYY-MM-DD` is a day in this zone) and the digest's date.
- **The markets' clocks**: each asset's exchange time zone (from its source: Yahoo's chart metadata or EODHD's exchange details; `Asia/Jakarta` for IDX, `America/New_York` for US listings, `UTC` for crypto…). It sets the asset's trading session, trading dates, daily candles and volume anomalies.

## Pipelines (Step Functions)

Both state machines share the same steps (`backend/src/handlers/pipeline.ts`, logic in `src/pipeline/`). Every execution belongs to one profile (`profileId` in the state) and uses only its categories, settings, subject and dedupe keys.

**Daily schedules:** each profile's run is started by its own EventBridge Scheduler schedule (named after the profile, in the stack's group `<resourcePrefix>-<stage>-daily-runs`; `backend/src/lib/schedules.ts`). It fires at the profile's run time plus a fixed offset of 0–14 minutes derived from its ID (`dailyRunStart` in `shared/src/profile.ts`, also shown in Settings), so profiles with the same time don't hit the sources and the LLM at once, and a profile's runs stay 24 hours apart. Saving the run time (or turning the run off) updates the schedule; a failed start is retried for an hour, and the `DailyRunStartsDropped` alarm fires if one is dropped. The schedules are created by the API, not by CloudFormation, so a new stack (or a changed `timeZone`) needs `migrate:profiles --schedules` to write them.

1. **start** — a daily run with no category to search (or whose account lost access) ends here without a run record. Otherwise create the run record and the search tasks (one per Google News query, in the query's edition: country and language, `EDITIONS` in `shared/src/editions.ts`; GDELT, which has no editions, gets each category's query once, batched into sequential tasks to respect its rate limit). Daily window: since the profile's last successful run, between 24 hours and 7 days. Google News gets the last 24 hours (`when:1d`) and, when the window is longer (a failed run, an outage, a changed run time), each older calendar day on its own (`after:`/`before:`), because it returns a smaller selection for any window over a day; GDELT gets the exact window. Backfill: date windows of 7/14/30 days depending on the period.
2. **search** (Map, concurrency 2–3) — fetch results, store raw hits in S3. A failing query is skipped, not fatal.
3. **collect** — merge duplicates across queries/providers (URL, Google News id, headline + outlet) and drop anything the profile already knows (its alias items in DynamoDB).
4. **prefilter** — the LLM screens headlines in batches of 50 against the profile's subject; obvious noise is stored as `FILTERED` (restorable for 30 days), the rest becomes one S3 item per candidate.
5. **enrich** (Distributed Map, concurrency 4) — decode Google News links, fetch + extract the article (Readability, SSRF-guarded), tag it with the LLM (sentiment per the profile's subject, optionally with its recent corrections as examples), store it as `PENDING`.
6. **digest** — LLM summary and overall sentiment of what the run found → DynamoDB → the profile's Telegram chats (the profile's name, summary, overall sentiment, item counts and a button to the profile's review queue).
7. **finish** — aggregate token usage, mark the run succeeded; for backfills, activate the category. Any failure → **fail** step: mark the run failed and alert on Telegram.

**Dedupe keys and deletes:** an article's alias items (URL, Google News id, headline + outlet) keep later runs from adding it again, and the article records their ids (`aliasIds`). Deleting from the recycle bin (`REJECTED`) deletes the article and its alias items, so a later run or backfill can find it again. Deleting from *Filtered by AI* is a soft delete (`deletedAt`, GSI1 keys removed): hidden from the list and counts, alias items kept, so later runs keep filtering it out.

## Data model (DynamoDB single table)

Keys `PK`/`SK`, index `GSI1` (`GSI1PK`/`GSI1SK`), TTL attribute `expiresAt`, stream `NEW_AND_OLD_IMAGES`.

Everything a profile owns lives in its partition `PROFILE#<id>`; an account's partition `ACCOUNT#<sub>` lists its profiles; market data is shared per asset. Assets are named by an ID, `<source>:<symbol>` with the symbol in the source's own format (`yahoo:D05.SI`, `eodhd:AAPL.US`; `assetId` in `shared/src/stock.ts`).

| Item | PK / SK | Notes |
|---|---|---|
| Profile | `ACCOUNT#<sub>` / `PROFILE#<id>`, and `PROFILE#<id>` / `PROFILE` | The account's list of profiles (name, created), and the profile's own record (name, owning account) for jobs that only know the profile |
| Article | `PROFILE#<id>` / `ART#<id>` | `suggestion` (AI), `final` (reviewer: tags, sentiment, edited summary/reason), status `PENDING/APPROVED/REJECTED/FILTERED`, `aliasIds`, `deletedAt` (soft-deleted filtered). GSI1 = `PROFILE#<id>#STATUS#<status>` / `<publishedAt>#<id>` |
| Alias | `PROFILE#<id>` / `ALIAS#<url\|gnews\|title>#<hash>` | De-duplication (`articleId`); deleted with a recycle-bin article, kept for a filtered one |
| Category | `PROFILE#<id>` / `CATEGORY#<id>` | Queries (each with its Google News edition), exclusions, sources, backfill status |
| Settings | `PROFILE#<id>` / `SETTINGS` | Subject (incl. the sentiment asset), assets (`stock.assets`: asset IDs), models, schedule, sources, notifications, learning |
| Telegram connection | `PROFILE#<id>` / `TELEGRAM#<chatId>_<topicId or 0>` | One of the profile's chats or forum topics (up to 10); the bot's getUpdates offset is `TELEGRAM` / `BOT` |
| Run | `PROFILE#<id>` / `RUN#<runId>` (time-sortable) | Stats (atomic counters), usage, error |
| Digest | `PROFILE#<id>` / `DIGEST#<createdAt>#<id>` | Latest = newest |
| Feedback | `PROFILE#<id>` / `FEEDBACK#<decidedAt>#<articleId>` | Training data: AI suggestion, reviewer's decision, changed fields |
| Volume alert | `PROFILE#<id>` / `ANOMALY#<asset ID>#<date>` | Notified anomalies (each profile has its own threshold) |
| Conversation | `PROFILE#<id>` / `CHAT#<id>` | Chat list; transcripts in S3 |
| Run item | `RUNITEM#<runId>` / `<articleId>` | Articles a run produced (digest input), TTL 60 days |
| Run usage | `RUNUSAGE#<runId>` / random | Token usage per step (race-free), folded into the run at the end |
| Stock | `STOCK#<asset ID>` / `D#<date>`, `I#<epoch>` (15-min bars, TTL 10 days), `QUOTE`, `STATUS`, `META` | Candles, latest quote, refresh status (`eodDoneFor`), asset metadata (ID, source, symbol, name, exchange, type, time zone, session, intraday interval, decimals, volume) |
| Telegram link code | `TGLINK#<code>` / `TGLINK` | One-time link codes (TTL) for one profile and one kind of chat (private or group), `linkedChatTitle` once seen |

**S3 data bucket:** `profiles/<id>/articles/<id>.json` (extracted text), `profiles/<id>/chats/<id>.json`, `raw/<runId>/…` and `runs/<runId>/…` (pipeline scratch, 90-day lifecycle).

**S3 Vectors index** `articles-<embedding-model>-<dims>`: one vector per chunk (`<profileId>#<articleId>#<n>`; chunk 0 = headline + effective summary). Filterable metadata: `owner` (the profile; every query filters on it), `articleId`, `publishedAt`, `categoryIds`, `sentiment`; non-filterable: `title`, `text`, `source`. Only `APPROVED` articles are indexed; edits re-index, un-saving removes the vectors.

**Market data:** the stock refresh (`backend/src/handlers/stock-ingest.ts`) runs every 15 minutes for the union of all profiles' assets (of accounts with access), each through its source's provider (`backend/src/stock/`: `yahoo.ts`, `eodhd.ts`, picked by `stockProvider(source)`; `STOCK_SOURCE_INFO` in `shared/src/stock.ts` describes each source's symbol format and timing). Each asset's session pattern (local start/end, weekdays or every day) comes from its source and decides when it is polled (`backend/src/stock/session.ts`): while open, the latest intraday bars and quote (only the quote for EODHD, whose bars arrive after the close); one end-of-day pass once the source has settled the day (an hour after the close for Yahoo, three for EODHD). 15-minute bars expire after 10 days; the intraday CSV download asks the source instead (Yahoo: 60 days, EODHD: 120). Sources other than Yahoo are offered once their API key is in the API keys parameter (`configuredSources`).

## API (all routes Cognito-authorized; all but `/profiles` and `/admin` act on the profile in `X-Profile-Id`)

| Area | Routes |
|---|---|
| News | `GET /news`, `GET /news/counts`, `GET\|PATCH /news/{id}`, `POST /news/bulk`, `POST /news/delete`, `GET /digest/latest`, `GET /feedback/stats` |
| Categories | `GET\|POST /categories`, `PATCH\|DELETE /categories/{id}`, `POST /categories/{id}/backfill`, `POST /categories/suggest-queries` |
| Settings | `GET\|PUT /settings`, `GET /settings/models`, `POST /settings/test-model`, `GET /runs`, `POST /runs/daily` |
| Stock | `GET\|POST /stock/assets` (add: `{source, symbol}`; the list includes the usable sources), `DELETE /stock/assets?asset=`, `GET /stock/search?source=&q=` (symbols matching a name or ticker), `GET /stock/history?asset=&range=`, `GET /stock/export?asset=&interval=1d\|intraday` (stored daily bars, or the source's recent intraday bars, as CSV), `GET /stock/anomalies?asset=&from=`, `POST /stock/resync` |
| Telegram | `POST /telegram/link` (a link code for a private chat or a group), `POST /telegram/link/verify`, `DELETE /telegram/links/{id}`, `POST /telegram/links/{id}/test` |
| Profiles (no `X-Profile-Id`) | `GET\|POST /profiles`, `PATCH\|DELETE /profiles/{id}` |
| Admin (`admins` group) | `GET\|POST /admin/users`, `PATCH\|DELETE /admin/users/{username}`, `POST /admin/users/{username}/invite` |
| Chat | `POST /chat` (AI SDK UI message stream), `GET /chat/conversations`, `GET\|DELETE /chat/conversations/{id}` |

## Security

- No public sign-up; Cognito authorizer on every non-preflight method (asserted in `backend/test/stack.test.ts`).
- Only members of the Cognito group `dashboard-users` can use the API (checked in the router and the chat stream); optional Google sign-in (`googleClientId`) creates users for any Google account, so the group is what grants access.
- Members of `admins` (who also need `dashboard-users`) manage users on the Admin page: `/admin/users` (`backend/src/handlers/api/admin.ts`, the only function allowed to create users and change groups). Deleting a user locks them out, then the `DeleteWorker` function goes through the account's profiles: it deletes each one's schedule, stops its runs, deletes its partition and objects (`backend/src/repo/profile-data.ts`; the vectors go through the indexer's stream), and finally deletes the Cognito user. It carries on in a new invocation when an account has many profiles. Deleting a single profile (Settings) goes through the same worker.
- Accounts are isolated: every item and object is keyed by a profile, a request's profile must be one of the signed-in account's (its `sub` from the ID token), the chat's vector search always filters on `owner`, and stock routes only serve the profile's own assets.
- Least-privilege grants per Lambda; private, encrypted buckets behind CloudFront OAC.
- Article text is treated as untrusted (delimited in prompts, structured output); chat tools are read-only.
- The article fetcher blocks private, loopback, link-local and metadata addresses on every redirect hop.
- cdk-nag (AwsSolutions) runs on every synth; accepted findings are listed with reasons in `backend/lib/nag.ts`.
