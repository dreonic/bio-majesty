# News Accumulator (bio-majesty)

Collects, tags and summarises the news on whatever each account follows: a company, a person, an industry or a policy area.

- **Accounts** — every member of the Cognito group `dashboard-users` has their own, separate workspace: profile, categories, review queue, saved news, chat, assets, settings and Telegram chat. Nobody sees another account's news.
- **News** — an AI pipeline searches Google News (each query in the country and language edition it picks) and GDELT daily, and historically when you add a category. It tags each article with categories and a sentiment (*positive / negative / neutral / undecided*) toward what the account's **profile** names (the subject itself, or the price of one of its assets) and queues it for review. The reviewer saves, edits or skips each item; saved news is searchable by keyword, category, sentiment and time window.
- **Chat** — an assistant that answers questions over the account's saved news (with source links) and the prices of its assets.
- **Stock** — price and volume of the account's assets (stocks, ETFs, indices, currencies, crypto, futures), picked with the ticker dropdown in the resizable, collapsible right panel, and alerts for unusual trading volume.
- **Telegram** — a digest after every run (summary, overall sentiment, number of new items and a button to the review queue), plus alerts for failed runs and unusual volume, to each account's own chat.

## Repository layout

```
shared/     zod schemas, API types, model catalog, volume-anomaly logic (used by both sides)
backend/    AWS CDK app (lib/) + Lambda handlers (src/) + scripts/ + tests
frontend/   React + Vite SPA (hosted on S3 + CloudFront)
docs/       architecture, paid alternatives, visual design notes, explainer deck
```

Architecture, data model and pipelines: [docs/architecture.md](docs/architecture.md). A non-technical walkthrough of how it all works (frontend and backend), presented on 16 October 2026 while the dashboard still followed a single company: [docs/16oct-slides.pdf](docs/16oct-slides.pdf), editable as [.pptx](docs/16oct-slides.pptx).

## Try the UI without AWS

```bash
npm install
npm run dev:mock -w frontend      # http://localhost:5173 — fictional sample data, no AWS calls
```

Mock mode serves a fictional company (Acme Group), invented headlines, prices (for the fictional ACME, ^GSPC and BTC-USD, plus EURUSD=X to add in Settings) and a streamed demo chat answer from an in-browser fake API, so you can review the layout and flows (review queue, tag editing, settings, the ticker dropdown, collapsing the stock panel) before deploying. It shows a single account. Open http://localhost:5173/?blank to start as a brand-new account instead (blank profile, no categories, news or assets).

## Configuration

All deployment settings live in `backend/cdk.json` → `context` and can be overridden per command with `-c key=value`:

| Key | Default | Notes |
|---|---|---|
| `stage` | `dev` | `prod` retains data (table, buckets, user pool) on stack deletion and disables the localhost callback |
| `region` | `ap-southeast-1` (Singapore) | **The one place to change the region**, e.g. `-c region=ap-southeast-3` for Jakarta (an opt-in region: enable it in the account first). The region must offer S3 Vectors, API Gateway REST response streaming and Cognito managed login (Singapore and Jakarta do) |
| `account` | `297580066575` (the company account) | The AWS account to deploy to. A command run with another account's credentials (e.g. a personal default profile) stops with an account-mismatch error instead of deploying there. Use the company profile: `--profile biomajesty` or `$env:AWS_PROFILE='biomajesty'` |
| `timeZone` | `Asia/Singapore` | The dashboard's clock: the daily-run times the accounts pick in Settings, the times the dashboard shows, and what "today" means in chat and news filters. Market data follows each asset's own exchange clock (e.g. Jakarta for IDX, New York for US listings). Changing it moves every account's run time to the same clock time in the new zone |
| `embeddingModel` / `embeddingDimensions` | `google:gemini-embedding-2` / `768` | Changing either creates a new vector index; saved articles must then be re-indexed |
| `alarmEmail` | — | Receives CloudWatch alarm emails (pipeline failures, ingest errors) |
| `customDomainName` / `customDomainCertificateArn` | — | Optional custom domain for the dashboard (ACM certificate in us-east-1) |
| `googleClientId` | — | Adds **Sign in with Google** to the login page (see *Google sign-in* below). The client secret goes in the SSM parameter `/bio-majesty/<stage>/google-client-secret` |

Runtime settings (profile, categories, assets, AI model per task, daily run time, data-source toggles, Telegram, volume alerts, "use past corrections") are edited in the dashboard's **Settings** page, separately for each account.

## Deploy

Prerequisites: Node.js 24 (≥ 22), AWS CLI with credentials for the target account, and a CDK bootstrap in the target region.

```bash
npm install
npm test && npm run typecheck          # optional sanity checks
npm run synth                          # local synth + cdk-nag security checks (no AWS changes)

npx cdk bootstrap aws://<ACCOUNT>/<REGION>   # once per account/region (run in backend/)
npm run deploy                          # builds the frontend, then `cdk deploy --all` (dev stage)
# production: npm run build && (cd backend && npx cdk deploy -c stage=prod)
```

The stack prints `DashboardUrl`, `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `CognitoDomain`, `ApiKeysParameter` and `StockIngestFunction`.

### Continuous deployment (GitHub Actions)

[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) typechecks, tests, builds and synthesizes (with cdk-nag) every pull request and every push to `main`. A push to `main` then deploys the dev stage with the app that passed those checks, and confirms the dashboard and its `config.json` respond. Changes that only touch Markdown or `docs/` don't redeploy. To redeploy without a change, use **Actions → CI/CD → Run workflow** on `main`.

GitHub signs in to AWS through OIDC, so no AWS keys are stored in GitHub. The role `bio-majesty-github-deploy` can only be assumed by workflows on `main` of `dreonic/bio-majesty` (matched by the account and repository IDs GitHub puts in its token, so a renamed or re-created repository doesn't qualify), and it can do nothing except assume the CDK bootstrap roles (the same path a local `cdk deploy` takes). Create it once per account, from your machine with the company profile:

```bash
npm run deploy:github-ci -w backend -- --profile biomajesty   # stack BioMajesty-GitHubCi
```

The pipeline deploys what is committed: settings in `backend/cdk.json` (e.g. `googleClientId`) only reach AWS once they're pushed to `main`. Run history and the deployed URL are under the repository's **Actions** tab.

### One-off: search editions for existing categories

Search queries used to name only a language (always Google News Indonesia); they now name an edition (country and language). `migrate:editions` gives the stored queries theirs (`id` → `ID:id`, `en` → `ID:en`), with the company profile and the `StockIngestFunction` stack output:

```bash
AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:editions -w backend -- \
  --function <StockIngestFunction> --backup-dir ./backup --dry-run
```

Run it without `--dry-run` right before pushing the version with editions, and again right after its deploy: it is idempotent and keeps the old `lang` field, so both versions work while the deploy runs, and the second run picks up categories saved in between. It also lists accounts that have categories but never saved a profile or asset list (those used the old defaults and now start blank). Once all is well, `--cleanup --yes` removes `lang`; delete the local `backend/backup/` folder afterwards.

### One-off: overall sentiment for existing digests

Digests now carry the run's overall sentiment (`overall`, null when the digest model failed). `migrate:digest-overall` gives the digests stored before it `overall: null`:

```bash
AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:digest-overall -w backend -- \
  --function <StockIngestFunction> --dry-run
```

Run it without `--dry-run` right before pushing that version and again right after its deploy (it only adds the attribute, and is idempotent).

### After the first deploy

1. **API keys** — all keys live in one encrypted SSM parameter (SecureString, free on the standard tier with the AWS managed key `aws/ssm`), named by the `ApiKeysParameter` stack output. CloudFormation can't create SecureStrings, so create it yourself (leave out the providers you don't use, or keep `REPLACE_ME`):
   ```bash
   aws ssm put-parameter --name /bio-majesty/dev/api-keys --type SecureString --value '{
     "ANTHROPIC_API_KEY": "...",
     "GOOGLE_GENERATIVE_AI_API_KEY": "...",
     "OPENAI_API_KEY": "REPLACE_ME",
     "OPENROUTER_API_KEY": "REPLACE_ME",
     "TELEGRAM_BOT_TOKEN": "...",
     "EODHD_API_KEY": "REPLACE_ME"
   }'
   ```
   To change a key later, edit the JSON in the console (Systems Manager → Parameter Store → the parameter → Edit) or run the same command with `--overwrite`; the Lambdas pick it up within 5 minutes. With the defaults you need an Anthropic key (Claude models) and a Google key (Gemini embeddings for chat search). Providers without a key are simply unavailable in Settings.
2. **Users** — there is no public sign-up. Invite each user:
   ```bash
   aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username someone@company.com \
     --user-attributes Name=email,Value=someone@company.com Name=email_verified,Value=true
   ```
   Cognito emails a temporary password; MFA (authenticator app) can be enabled at first login.

   **Access** — signing in is not enough: only members of the `dashboard-users` group can use the dashboard (the API returns 403 to anyone else, and the page shows *No access yet*). Add each user to the group in the **Cognito console** (User pools → bio-majesty-dev → Groups → dashboard-users → Add user to group) or with:
   ```bash
   aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username someone@company.com --group-name dashboard-users
   ```
   Removing someone from the group takes effect when their login token renews (within an hour), and stops their daily runs and price refreshes; *Disable user* in the console also stops them signing in again.

   **Every member is a separate account.** A new account starts blank: no profile subject, categories or assets, so no news runs until it adds a category. Its data stays in its own partition: nobody else can see its news, chats or settings, and its daily run uses only its own categories (so two accounts following the same company each pay for their own AI tagging).

   **Google sign-in** (optional) — with `googleClientId` set, the login page also offers Google. Any Google account can then sign in and gets a Cognito user, so the group above is what keeps the dashboard private.
   1. In the [Google Cloud console](https://console.cloud.google.com/auth/clients), set up the OAuth consent screen (choose *Internal* if the company uses Google Workspace: only company accounts can then sign in), then create an OAuth client of type *Web application* with
      - Authorized JavaScript origin: `<CognitoDomain>`
      - Authorized redirect URI: `<CognitoDomain>/oauth2/idpresponse`
   2. Store the client secret, then put the client ID in `googleClientId` in `backend/cdk.json` and deploy:
      ```bash
      aws ssm put-parameter --name /bio-majesty/dev/google-client-secret --type String --value '<client secret>'
      ```
      It is a plain `String`, not a SecureString: CloudFormation can't pass SecureStrings to Cognito (and Cognito shows the secret to anyone allowed to view the identity provider anyway). CloudFormation reads it only when it creates or changes the Google identity provider, so after changing the secret later, also paste it into the Cognito console (the user pool → Social and external providers → Google → Edit).
   3. A colleague signs in with Google once (they see *No access yet*), then you add them to `dashboard-users`; they press *Check again*. In the console, Google users are listed as `google_<number>` with their email.
3. **Telegram** — create a bot with [@BotFather](https://t.me/BotFather), put its token in the API keys parameter (`TELEGRAM_BOT_TOKEN`), then each account uses **Settings → Connect Telegram** and presses *Start* in the chat that should receive its notifications (one bot serves every account).
4. **Profile** — **Settings → Profile**: who or what the news is about (blank for a new account; left empty, the AI follows the topics of the categories) and what sentiment is judged against.
5. **Categories** — **Settings → Add category**. Start from a template (named after the profile's subject: the subject itself, regulation and policy, competitors, industry and market, people and leadership) or your own name and description. *Suggest with AI* drafts the queries, each with the Google News edition (country and language) to search. Each new category runs a backfill and joins the daily run when it finishes.
6. **Assets** — **Settings → Assets → Add** (up to 10): type a name to search, or a symbol in the source's own format, and check the match shown under the box. Yahoo Finance is always offered; EODHD joins it in the source list once `EODHD_API_KEY` is in the API keys parameter. The history loads in the background; **Resync** reloads it.

### Local development against a deployed stack

Copy `frontend/public/config.example.json` to `frontend/public/config.json`, fill in the stack outputs, and run `npm run dev -w frontend`. Non-prod stages allow `http://localhost:5173` as a Cognito callback and CORS origin.

## How it works

- **Daily run**, one per account, at the time it picks in Settings (quarter hours, default 06:00 Singapore time; a dispatcher checks every 15 minutes): Google News RSS (each query in its edition) + GDELT searches for every active category's queries since the account's last successful run → de-duplication → a cheap AI headline prefilter → for each relevant item: resolve the publisher URL, extract the article text, tag it (categories, sentiment, reason, summary) → a digest → Telegram. Orchestrated by Step Functions; see [docs/architecture.md](docs/architecture.md).
- **Backfill** (when a category is added): the same pipeline over historical date windows.
- **Review**: every suggested article waits in the *Review* tab. Tags are chips (× to remove, **+** to add), sentiment is a picker, and the summary and "why" reason are editable in place. *Save* / *Skip* (or `S` / `X`, `J`/`K` to move).
  - Skipped news goes to the **Recycle bin** (restore one, or *Delete all*). While it is there, later runs and backfills leave it out. Deleting it from the bin forgets it: a later run or backfill can find it again.
  - Headlines the AI dropped are listed under **Filtered by AI** for 30 days, where they can be ticked (or all selected) and restored to review or deleted. Deleting there hides them but remembers them, so later runs keep filtering them out.
- **Training feedback**: every save, skip and edit is stored with the AI's original suggestion and the list of fields the reviewer changed — data for training a classifier later (`npm run export:feedback -w backend -- --sub <User ID>`). **Settings → Daily run → "Use my past corrections as context"** (off by default) additionally shows the account's most recent corrections to the tagging model as examples.
- **Chat**: semantic search over the account's saved articles (S3 Vectors), plus listing, full-text reading and the prices of its assets as tools; answers stream through API Gateway.
- **Stock**: each asset comes from the source it was added from: Yahoo Finance (free, unofficial; 15-minute delayed bars during the session) or EODHD (paid; 5-minute bars rolled up to 15 minutes, finalized 2–3 hours after the close, so during the session an EODHD asset only updates its quote). Every 15 minutes the refresh asks only for assets whose market is open (each on its own exchange clock: IDX 09:00–16:15 WIB, US 09:30–16:00 New York, crypto around the clock), plus one end-of-day refresh per asset once its source has settled the day (an hour after the close for Yahoo, three for EODHD). Days whose volume reaches 2.5× the 20-day average (each account sets its own threshold) are listed under *Unusual volume*, drawn as bold volume bars, and alerted on Telegram once per day — during the session when the running volume already crosses the threshold, otherwise after the close. 15-minute bars are kept for 10 days (enough for the 1D and 5D charts); daily bars for good. The stock panel's footer downloads every daily bar since listing, or the 15-minute bars straight from the asset's source (Yahoo: the last 60 days; EODHD: 120), as CSV.
- **Assets**: anything a source has a symbol for, in that source's format (Yahoo `D05.SI`, `^JKSE`, `USDIDR=X`; EODHD `AAPL.US`, `VOD.LSE`, `EURUSD.FOREX`). The same ticker from two sources is two assets with separate histories. On Yahoo, checked on 2026-10-21: stocks (an IDX listing, D05.SI, AAPL), ETFs (EIDO), indices (^JKSE), currencies (USDIDR=X), crypto (BTC-USD) and futures (GC=F) all have 15-minute bars for the last 60 days; mutual funds (e.g. VFIAX) only daily bars, so their 1D/5D views and 15-minute download are hidden. Currencies and most indices have no volume, so they never alert.

## AI models

The LLM layer is provider-agnostic (Vercel AI SDK): Anthropic, OpenAI, Google Gemini and OpenRouter (hundreds of models with one key). **Settings → AI models** picks a model, reasoning effort and optional fallback model per task (query suggestions, headline prefilter, tagging, digest, chat); a *Test* button checks each choice. Defaults are **Claude Opus 5.5** for every task, with Anthropic's server-side refusal fallback (`fallbacks: "default"`) enabled automatically for Claude models that support it.

Before switching the tagging model, measure it against an account's own decisions (`<User ID>` is the account's `sub` in the Cognito console):

```bash
TABLE_NAME=... DATA_BUCKET=... AWS_REGION=ap-southeast-1 ANTHROPIC_API_KEY=... \
  npm run eval:tagging -w backend -- anthropic:claude-haiku-5-5 --sub <User ID> --limit 50
```

Other scripts: `smoke:models` (every configured model can tag and call tools), `try:classify <url>` (tag one article with the current prompts). These call real model APIs.

## Data sources and their caveats

Free/unofficial by choice; each has a documented paid fallback in [docs/alternatives.md](docs/alternatives.md).

- **Google News RSS** — 26 country and language editions, picked per query (`EDITIONS` in `shared/src/editions.ts`, each checked on 2026-10-27); links are Google redirects that are decoded to publisher URLs on a best-effort basis (unofficial; if decoding fails the Google link is kept). About 100 results per query and window.
- **GDELT** — free, publisher URLs, but only the last ~3 months and one request per 5 seconds.
- **Yahoo Finance** (via `yahoo-finance2`) — unofficial, may rate-limit AWS IPs; each extra asset adds requests (an asset trading around the clock costs 96 a day), hence the 10-asset limit per account. The panel shows a *Not updating* badge and Telegram alerts after three failed refreshes; then add the asset again from EODHD.
- **EODHD** (optional, paid) — offered in **Settings → Assets** once `EODHD_API_KEY` is in the API keys parameter. Its own symbol format (`TICKER.EXCHANGE`, e.g. `AAPL.US`, `VOD.LSE`); intraday bars only after the close. The self-serve plans are for personal use; see [docs/alternatives.md](docs/alternatives.md) for the commercial terms.
- The Google Custom Search JSON API is closed to new customers and shuts down on 1 January 2027, so it is not used.

## Costs (rough, per month)

AWS < $10 at this scale (Lambda, API Gateway, DynamoDB on-demand, S3, S3 Vectors, Step Functions, CloudFront, Cognito). Data sources $0. LLM tokens are the main cost, **per account** (each account's run tags its own news): with Opus 5.5 everywhere ≈ $30–45 for daily tagging, ~$5–15 per 12-month backfill, ~$0.10 per chat question — Sonnet roughly half, Haiku ≈ $1–3 for tagging. The *Daily run* table in Settings shows tokens per run.

## Development

```bash
npm test            # shared + backend + frontend unit tests (vitest)
npm run typecheck   # TypeScript 7 across all workspaces
npm run synth       # CDK synth with cdk-nag (AwsSolutions) checks
```

Not yet built (kept easy to add): an MCP endpoint over the chat's news tools (for Claude Code / Claude Desktop / other agents), Telegram quick actions, near-duplicate story grouping, batch-API backfills, and stock-exchange disclosure monitoring (e.g. IDX or SGX filings).
