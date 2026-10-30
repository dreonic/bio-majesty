# News Accumulator (bio-majesty)

Collects, tags and summarises the news on whatever each profile follows: a company, a person, an industry or a policy area.

- **Accounts and profiles** — every member of the Cognito group `dashboard-users` is an account, and an account has one or more **profiles**, switched in the navbar's menu. Each profile is a separate desk: subject, categories, review queue, saved news, chat, assets, settings, daily run and Telegram chats. Whoever signs in to an account can open all of its profiles; nobody sees another account's.
- **News** — an AI pipeline searches Google News (each query in the country and language edition it picks) and GDELT daily, and historically when you add a category. It tags each article with categories and a sentiment (*positive / negative / neutral / undecided*) toward what the profile's **subject** names (the subject itself, or the price of one of its assets) and queues it for review. The reviewer saves, edits or skips each item; saved news is searchable by keyword, category, sentiment and time window.
- **Chat** — an assistant that answers questions over the profile's saved news (with source links) and the prices of its assets.
- **Stock** — price and volume of the profile's assets (stocks, ETFs, indices, currencies, crypto, futures), picked with the ticker dropdown in the resizable, collapsible right panel, and alerts for unusual trading volume.
- **Telegram** — a digest after every run (summary, overall sentiment, number of new items and a button to the review queue), plus alerts for failed runs and unusual volume, to each profile's own chats. Every message starts with the profile's name, and its button opens that profile.

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

Mock mode serves a fictional company (Acme Group), invented headlines, prices (for the fictional ACME, ^GSPC and BTC-USD, plus EURUSD=X to add in Settings) and a streamed demo chat answer from an in-browser fake API, so you can review the layout and flows (review queue, tag editing, settings, the ticker dropdown, collapsing the stock panel, switching profiles) before deploying. It has two fictional profiles. Open http://localhost:5173/?blank to start as a brand-new account instead (it names its first profile, then starts blank: no subject, categories, news or assets).

## Configuration

All deployment settings live in `backend/cdk.json` → `context` and can be overridden per command with `-c key=value`. Settings that differ per stage sit in that stage's block under `stages` (`stages.dev`, `stages.prod`); a top-level key or `-c` flag of the same name wins over the block.

| Key | Default | Notes |
|---|---|---|
| `stage` | `dev` | Picks the `stages.<stage>` block. `prod` retains data (table, buckets, user pool) on stack deletion and disables the localhost callback |
| `stackName` (per stage) | dev `BioMajesty-dev`, prod `news-accumulator` | CloudFormation stack name (default `<resourcePrefix>-<stage>`). Changing it creates a new, empty stack |
| `resourcePrefix` (per stage) | dev `bio-majesty`, prod `news-accumulator` | Start of the stage's resource names: user pool, Cognito domain prefix, SSM parameters (`/<resourcePrefix>/<stage>/...`), schedules, vector bucket. Dev keeps the old codename because renaming would replace its user pool and data |
| `region` | `ap-southeast-1` (Singapore) | **The one place to change the region**, e.g. `-c region=ap-southeast-3` for Jakarta (an opt-in region: enable it in the account first). The region must offer S3 Vectors, API Gateway REST response streaming and Cognito managed login (Singapore and Jakarta do) |
| `account` | `297580066575` (the company account) | The AWS account to deploy to. A command run with another account's credentials (e.g. a personal default profile) stops with an account-mismatch error instead of deploying there. Use the company profile: `--profile biomajesty` or `$env:AWS_PROFILE='biomajesty'` |
| `timeZone` | `Asia/Singapore` | The dashboard's clock: the daily-run times the profiles pick in Settings, the times the dashboard shows, and what "today" means in chat and news filters. Market data follows each asset's own exchange clock (e.g. Jakarta for IDX, New York for US listings). Each profile's schedule stores the zone when it is written, so after changing it, rewrite them all with `migrate:profiles --schedules` (see *One-off: profiles*); until then each profile keeps the old zone until its run time is saved again |
| `embeddingModel` / `embeddingDimensions` | `google:gemini-embedding-2` / `768` | Changing either creates a new vector index; saved articles must then be re-indexed |
| `alarmEmail` (per stage) | — | Receives CloudWatch alarm emails (pipeline failures, ingest errors). The repository is public, so to keep addresses out of it, subscribe them to the `AlarmTopicArn` output instead: `aws sns subscribe --topic-arn <AlarmTopicArn> --protocol email --notification-endpoint you@example.com` (each address confirms by email; deploys leave such subscriptions alone) |
| `domainName` / `authDomainName` / `certificateArn` (per stage) | — | Optional custom domains for the dashboard and for the login page, with one ACM certificate in **us-east-1** covering both (see *Custom domains* below) |
| `googleClientId` (per stage) | — | Adds **Sign in with Google** to the login page (see *Google sign-in* below). The client secret goes in the SSM parameter `/<resourcePrefix>/<stage>/google-client-secret` |
| `passwordSignIn` (per stage) | on; **off for dev and prod** | Email-and-password sign-in. Off means Google only (needs `googleClientId`): *Sign in* goes straight to Google, there are no passwords or email invitations, and each person is exactly one account. With both on, a person who used email and Google would get two separate accounts |

Runtime settings (subject, categories, assets, AI model per task, daily run time, data-source toggles, Telegram, volume alerts, "use past corrections") are edited in the dashboard's **Settings** page, separately for each profile.

## Deploy

Prerequisites: Node.js 24 (≥ 22), AWS CLI with credentials for the target account, and a CDK bootstrap in the target region.

```bash
npm install
npm test && npm run typecheck          # optional sanity checks
npm run synth                          # local synth + cdk-nag security checks (no AWS changes)

npx cdk bootstrap aws://<ACCOUNT>/<REGION>   # once per account/region (run in backend/)
npm run deploy                          # builds the frontend, then `cdk deploy --all` (dev stage)
npm run deploy:prod                     # the same for the prod stage (stack news-accumulator)
```

`npm run diff:prod -w backend` / `npm run synth:prod -w backend` show what a prod deploy would change. Normally prod is deployed from GitHub Actions (below); `deploy:prod` is the fallback from your machine with the company profile.

The stack prints `DashboardUrl`, `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `CognitoDomain`, `ApiKeysParameter`, `StockIngestFunction`, `DailyStateMachineArn`, `ProfilesFunction` (its environment names the table, buckets and schedule group, for scripts) and `AlarmTopicArn`, plus `DashboardDnsTarget` / `LoginDnsTarget` with custom domains.

### Continuous deployment (GitHub Actions)

[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) typechecks, tests, builds and synthesizes (with cdk-nag) every pull request and every push to `main`. A push to `main` then deploys the dev stage with the app that passed those checks, and confirms the dashboard and its `config.json` respond. Changes that only touch Markdown or `docs/` don't redeploy. To redeploy dev without a change, use **Actions → CI/CD → Run workflow** on `main`.

**Prod** follows the same run, but only with your approval: after the dev deploy succeeds, the run posts the prod diff (`cdk diff` against the deployed stack, no AWS changes) in its summary and waits. Read the diff and press **Review deployments → Approve** to deploy exactly that synthesized app; reject it (or leave it waiting) to keep that commit out of prod. Prod deploys queue one at a time: while one waits for approval, the newest later one waits behind it, so approve or reject the older one first. To redeploy prod without a new commit, use **Run workflow** with target `prod`.

GitHub signs in to AWS through OIDC, so no AWS keys are stored in GitHub. The role `bio-majesty-github-deploy` can only be assumed by workflows on `main` of `dreonic/bio-majesty` (matched by the account and repository IDs GitHub puts in its token, so a renamed or re-created repository doesn't qualify), and it can do nothing except assume the CDK bootstrap roles (the same path a local `cdk deploy` takes). Create it once per account, from your machine with the company profile:

```bash
npm run deploy:github-ci -w backend -- --profile biomajesty   # stack BioMajesty-GitHubCi
```

The prod deploy job runs in the GitHub environment `production`, and the role also trusts that environment's jobs, so the environment's rules are what guard prod. Create it once under **Settings → Environments → New environment** `production`: tick **Required reviewers** (add yourself; leave *Prevent self-review* off if you approve your own runs) and set **Deployment branches and tags** to *Selected branches* → `main`.

The pipeline deploys what is committed: settings in `backend/cdk.json` (e.g. `googleClientId`) only reach AWS once they're pushed to `main`. Run history and the deployed URL are under the repository's **Actions** tab.

### One-off: profiles

Data used to belong to an account (`USER#<sub>`, `users/<sub>/`, `chats/<sub>/`, vectors owned by the `sub`); it now belongs to a profile. `migrate:profiles` copies each account's data to its first profile, named after its subject (or *My news*): items, article texts, chats and chat vectors (copied, not re-embedded). On the way, the settings' `profile` becomes `subject`, and leftovers of earlier migrations go (the single `TELEGRAM` link item, queries' `lang`, backfills' `months`). The old layout stays until `--cleanup`. With the company profile:

```bash
# right before pushing the version with profiles (the old stack: its StockIngestFunction output)
AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:profiles -w backend -- \
  --function <StockIngestFunction> --dry-run      # then without --dry-run

# right after its deploy (the new stack: its ProfilesFunction output)
AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:profiles -w backend -- --function <ProfilesFunction>
AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:profiles -w backend -- --function <ProfilesFunction> --schedules

# once all is well: delete the old layout
AWS_PROFILE=biomajesty AWS_REGION=ap-southeast-1 npm run migrate:profiles -w backend -- --function <ProfilesFunction> --cleanup --yes
```

A repeated copy only adds what is missing, so the run after the deploy picks up what the old version saved in between without overwriting what the new version changed (edits the old version made to already-copied items in between are not carried over). Until `--schedules` has run, no daily run starts: the old dispatcher is gone, and each profile's schedule is created when the profile is, or when its run time is saved. Prod: copy right before approving the prod deploy.

### Custom domains

A stage can serve the dashboard on its own domain (`domainName`, e.g. `news.example.com`) and the Cognito login page on another (`authDomainName`, e.g. `login.news.example.com`). Both are CloudFront distributions, so they need one ACM certificate in **us-east-1** (whatever the stack's region) that covers both names:

1. Request the certificate in ACM in us-east-1 (both names, or a wildcard such as `*.example.com`), add the validation CNAMEs it shows at your DNS provider, and wait until it is *Issued*.
2. Put `domainName` and `certificateArn` in the stage's block in `backend/cdk.json` and deploy. Point `domainName` at the `DashboardDnsTarget` output (a CNAME, or an alias A/AAAA record on Route 53).
3. Cognito only accepts a login domain whose parent domain already resolves (for `login.news.example.com`, `news.example.com` must answer), so add `authDomainName` once step 2's record is live, deploy again, and point `authDomainName` at the `LoginDnsTarget` output. The login page then moves there (the prefix domain keeps working), and the dashboard picks it up from its `config.json`.
4. With Google sign-in on, add `https://<authDomainName>` and `https://<authDomainName>/oauth2/idpresponse` to the Google OAuth client (see *Google sign-in*).

### After the first deploy

1. **API keys** — all keys live in one encrypted SSM parameter (SecureString, free on the standard tier with the AWS managed key `aws/ssm`), named by the `ApiKeysParameter` stack output. CloudFormation can't create SecureStrings, so create it yourself (leave out the providers you don't use, or keep `REPLACE_ME`):
   ```bash
   aws ssm put-parameter --name /bio-majesty/dev/api-keys --type SecureString   # prod: /news-accumulator/prod/api-keys --value '{
     "ANTHROPIC_API_KEY": "...",
     "GOOGLE_GENERATIVE_AI_API_KEY": "...",
     "OPENAI_API_KEY": "REPLACE_ME",
     "OPENROUTER_API_KEY": "REPLACE_ME",
     "TELEGRAM_BOT_TOKEN": "...",
     "EODHD_API_KEY": "REPLACE_ME"
   }'
   ```
   To change a key later, edit the JSON in the console (Systems Manager → Parameter Store → the parameter → Edit) or run the same command with `--overwrite`; the Lambdas pick it up within 5 minutes. With the defaults you need an Anthropic key (Claude models) and a Google key (Gemini embeddings for chat search). Providers without a key are simply unavailable in Settings.
2. **Users** — there is no public sign-up. Manage people on the dashboard's **Admin** page, which only members of the Cognito group `admins` see. Make yourself the first admin once, after your first sign-in (Google users are listed in the console as `Google_<number>`):
   ```bash
   aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username <your username> --group-name dashboard-users
   aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username <your username> --group-name admins
   ```
   Then sign out and in again. On the Admin page you can:
   - **Give access** to people who signed in with Google: signing in is not enough, they appear under *Waiting for access* until an admin lets them in (they then press *Check again*).
   - **Invite** someone by email, only where `passwordSignIn` is on: Cognito emails a temporary password (valid 7 days; *Resend* sends a new one), and the user gets access straight away. MFA (authenticator app) can be enabled at first login. Where it is off, an email user can't sign in (the Admin page shows *Can't sign in*): delete it and ask the person to sign in with Google.
   - Switch **Access** and **Admin** per user, **Disable** someone (they can't sign in; their data stays), or **Delete** them with all their profiles' data (news, categories, assets, settings, chats, Telegram connections). Deleting locks the user out at once; the `DeleteWorker` function then goes through the account's profiles one by one (deleting the profile's schedule, stopping its runs, deleting its data) and finally deletes the user.

   Removing access or disabling someone takes effect when their sign-in renews (within an hour), and stops their profiles' daily runs and price refreshes. Admins can't remove their own access or admin role, or disable or delete themselves. The Cognito console (User pools → bio-majesty-dev or news-accumulator-prod) still works for the same things.

   **Every member is a separate account, with its own profiles.** A new account first names its first profile, which starts blank: no subject, categories or assets, so no news runs until it adds a category. More profiles come from **Add profile** in the navbar's menu (no limit; a new one opens its Settings); **Settings → This profile** renames or deletes the open one (not the last one, nor while its news run is in progress); the **Admin** page lists every account's ID and its profiles' IDs, for scripts. Each profile's data stays in its own partition, and its daily run uses only its own categories (so two profiles following the same company each pay for their own AI tagging). The dashboard remembers the last profile opened in each browser.

   **Google sign-in** (optional) — with `googleClientId` set, the login page also offers Google. Any Google account can then sign in and gets a Cognito user, so the group above is what keeps the dashboard private.
   1. In the [Google Cloud console](https://console.cloud.google.com/auth/clients), set up the OAuth consent screen (choose *Internal* if the company uses Google Workspace: only company accounts can then sign in), then create an OAuth client of type *Web application* with
      - Authorized JavaScript origin: `<CognitoDomain>`
      - Authorized redirect URI: `<CognitoDomain>/oauth2/idpresponse`
   2. Store the client secret, then put the client ID in `googleClientId` in `backend/cdk.json` and deploy:
      ```bash
      aws ssm put-parameter --name /bio-majesty/dev/google-client-secret --type String --value '<client secret>'
      ```
      Create it before deploying: CloudFormation reads it during the deploy and fails if it is missing. Each stage has its own parameter (prod: `/news-accumulator/prod/google-client-secret`).
      It is a plain `String`, not a SecureString: CloudFormation can't pass SecureStrings to Cognito (and Cognito shows the secret to anyone allowed to view the identity provider anyway). CloudFormation reads it only when it creates or changes the Google identity provider, so after changing the secret later, also paste it into the Cognito console (the user pool → Social and external providers → Google → Edit).
   3. A colleague signs in with Google once (they see *No access yet*), then an admin gives them access on the Admin page (*Waiting for access*); they press *Check again*.
3. **Telegram** — create a bot with [@BotFather](https://t.me/BotFather) and put its token in the API keys parameter (`TELEGRAM_BOT_TOKEN`). Each profile then connects one or more chats in **Settings → Telegram notifications** (up to 10; one bot serves every profile of a stage). Pick the kind first:
   - **Private chat**: open the bot from the link and press *Start*.
   - **Group or topic**: add the bot to the group, then send the shown command (`/start@<bot> <code>`) in the group, or in the topic of a forum supergroup that should get that profile's notifications. Several profiles can share one supergroup, each linked to its own topic; everyone in the group sees what is posted there. The bot needs no admin rights (it can't post in a closed topic).

   Each code only connects its kind of chat: Telegram sends `/start` by itself when you open a bot you've talked to before, so a group code can't end up in a private chat. Digests, run failures and volume alerts go to every connected chat or topic; each one has its own *Send test* and *Disconnect*. Messages start with the profile's name, and their button opens the dashboard on that profile. When Telegram rate-limits the bot (about 20 messages a minute per group), it waits the time Telegram asks for and sends again. Give each stage its own bot: the stages poll the bot for link codes, and two stages sharing one token would take each other's updates.
4. **Subject** — **Settings → Subject**: who or what the profile's news is about (blank for a new profile; left empty, the AI follows the topics of the categories) and what sentiment is judged against.
5. **Categories** — **Settings → Add category**. Start from a template (named after the subject: the subject itself, regulation and policy, competitors, industry and market, people and leadership) or your own name and description. *Suggest with AI* drafts the queries, each with the Google News edition (country and language) to search. A new category can first search the past (a backfill: a number of days, weeks, months or years, up to about 3 years; default 6 months) and joins the daily run when it finishes. **Backfill** runs another one later; *Cancel backfill* stops a running one (items already tagged stay in the Review tab), and deleting a category stops its backfill too. The Categories section sits below AI models in Settings.
6. **Assets** — **Settings → Assets → Add** (up to 10): type a name to search, or a symbol in the source's own format, and check the match shown under the box. Yahoo Finance is always offered; EODHD joins it in the source list once `EODHD_API_KEY` is in the API keys parameter. The history loads in the background; **Resync** reloads it.

### Local development against a deployed stack

Copy `frontend/public/config.example.json` to `frontend/public/config.json`, fill in the stack outputs, and run `npm run dev -w frontend`. Non-prod stages allow `http://localhost:5173` as a Cognito callback and CORS origin.

## How it works

- **Daily run**, one per profile, at the time it picks in Settings (quarter hours, default 06:00 Singapore time), plus a fixed 0–14 minutes that comes from the profile's ID. Settings shows the actual start time. The offset keeps profiles set to the same time from hitting the sources together, and each profile's runs stay 24 hours apart. Each profile has its own EventBridge Scheduler schedule, which starts the run directly. A run searches Google News RSS (each query in its edition) and GDELT for every active category's queries since the profile's last successful run → de-duplication → a cheap AI headline prefilter → for each relevant item: resolve the publisher URL, extract the article text, tag it (categories, sentiment, reason, summary) → a digest → Telegram. Orchestrated by Step Functions; see [docs/architecture.md](docs/architecture.md).
- **Backfill** (when a category is added): the same pipeline over historical date windows.
- **Review**: every suggested article waits in the *Review* tab. Tags are chips (× to remove, **+** to add), sentiment is a picker, and the summary and "why" reason are editable in place. *Save* / *Skip* (or `S` / `X`, `J`/`K` to move).
  - Skipped news goes to the **Recycle bin** (restore one, or *Delete all*). While it is there, later runs and backfills leave it out. Deleting it from the bin forgets it: a later run or backfill can find it again.
  - Headlines the AI dropped are listed under **Filtered by AI** for 30 days, where they can be ticked (or all selected) and restored to review or deleted. Deleting there hides them but remembers them, so later runs keep filtering them out.
- **Training feedback**: every save, skip and edit is stored with the AI's original suggestion and the list of fields the reviewer changed — data for training a classifier later (`npm run export:feedback -w backend -- --profile-id <profile ID>`). **Settings → Daily run → "Use my past corrections as context"** (off by default) additionally shows the profile's most recent corrections to the tagging model as examples.
- **Chat**: semantic search over the profile's saved articles (S3 Vectors), plus listing, full-text reading and the prices of its assets as tools; answers stream through API Gateway.
- **Stock**: each asset comes from the source it was added from: Yahoo Finance (free, unofficial; 15-minute delayed bars during the session) or EODHD (paid; 5-minute bars rolled up to 15 minutes, finalized 2–3 hours after the close, so during the session an EODHD asset only updates its quote). Every 15 minutes the refresh asks only for assets whose market is open (each on its own exchange clock: IDX 09:00–16:15 WIB, US 09:30–16:00 New York, crypto around the clock), plus one end-of-day refresh per asset once its source has settled the day (an hour after the close for Yahoo, three for EODHD). Days whose volume reaches 2.5× the 20-day average (each profile sets its own threshold) are listed under *Unusual volume*, drawn as bold volume bars, and alerted on Telegram once per day — during the session when the running volume already crosses the threshold, otherwise after the close. 15-minute bars are kept for 10 days (enough for the 1D and 5D charts); daily bars for good. The stock panel's footer downloads every daily bar since listing, or the 15-minute bars straight from the asset's source (Yahoo: the last 60 days; EODHD: 120), as CSV.
- **Assets**: anything a source has a symbol for, in that source's format (Yahoo `D05.SI`, `^JKSE`, `USDIDR=X`; EODHD `AAPL.US`, `VOD.LSE`, `EURUSD.FOREX`). The same ticker from two sources is two assets with separate histories. On Yahoo, checked on 2026-10-21: stocks (an IDX listing, D05.SI, AAPL), ETFs (EIDO), indices (^JKSE), currencies (USDIDR=X), crypto (BTC-USD) and futures (GC=F) all have 15-minute bars for the last 60 days; mutual funds (e.g. VFIAX) only daily bars, so their 1D/5D views and 15-minute download are hidden. Currencies and most indices have no volume, so they never alert.

## AI models

The LLM layer is provider-agnostic (Vercel AI SDK): Anthropic, OpenAI, Google Gemini and OpenRouter (hundreds of models with one key). **Settings → AI models** picks a model, reasoning effort and optional fallback model per task (query suggestions, headline prefilter, tagging, digest, chat); a *Test* button checks each choice. Defaults are **Claude Haiku 5.5** (the smallest and cheapest Claude model) for every task; Anthropic's server-side refusal fallback (`fallbacks: "default"`) is enabled automatically for the Claude models that support it (Opus, Sonnet, Fable).

Before switching the tagging model, measure it against a profile's own decisions (profile IDs are listed on the **Admin** page):

```bash
TABLE_NAME=... DATA_BUCKET=... AWS_REGION=ap-southeast-1 ANTHROPIC_API_KEY=... \
  npm run eval:tagging -w backend -- anthropic:claude-haiku-5-5 --profile-id <profile ID> --limit 50
```

Other scripts: `smoke:models` (every configured model can tag and call tools), `try:classify <url>` (tag one article with the current prompts). These call real model APIs.

## Data sources and their caveats

Free/unofficial by choice; each has a documented paid fallback in [docs/alternatives.md](docs/alternatives.md).

- **Google News RSS** — 26 country and language editions, picked per query (`EDITIONS` in `shared/src/editions.ts`, each checked on 2026-10-27); links are Google redirects that are decoded to publisher URLs on a best-effort basis (unofficial; if decoding fails the Google link is kept). About 100 results per query and window.
- **GDELT** — free, publisher URLs, but only the last ~3 months and one request per 5 seconds.
- **Yahoo Finance** (via `yahoo-finance2`) — unofficial, may rate-limit AWS IPs; each extra asset adds requests (an asset trading around the clock costs 96 a day), hence the 10-asset limit per profile (several profiles tracking the same asset share its requests). The panel shows a *Not updating* badge and Telegram alerts after three failed refreshes; then add the asset again from EODHD.
- **EODHD** (optional, paid) — offered in **Settings → Assets** once `EODHD_API_KEY` is in the API keys parameter. Its own symbol format (`TICKER.EXCHANGE`, e.g. `AAPL.US`, `VOD.LSE`); intraday bars only after the close. The self-serve plans are for personal use; see [docs/alternatives.md](docs/alternatives.md) for the commercial terms.
- The Google Custom Search JSON API is closed to new customers and shuts down on 1 January 2027, so it is not used.

## Costs (rough, per month)

AWS < $10 at this scale (Lambda, API Gateway, DynamoDB on-demand, S3, S3 Vectors, Step Functions, CloudFront, Cognito). Data sources $0. LLM tokens are the main cost, **per profile** (each profile's run tags its own news): with Opus 5.5 everywhere ≈ $30–45 for daily tagging, ~$5–15 per 12-month backfill, ~$0.10 per chat question — Sonnet roughly half, Haiku ≈ $1–3 for tagging. The *Daily run* table in Settings shows tokens per run.

## Development

```bash
npm test            # shared + backend + frontend unit tests (vitest)
npm run typecheck   # TypeScript 7 across all workspaces
npm run synth       # CDK synth with cdk-nag (AwsSolutions) checks
```

Not yet built (kept easy to add): an MCP endpoint over the chat's news tools (for Claude Code / Claude Desktop / other agents), Telegram quick actions, near-duplicate story grouping, batch-API backfills, and stock-exchange disclosure monitoring (e.g. IDX or SGX filings).
