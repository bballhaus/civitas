# AGENTS.md

Guidance for AI coding agents working in this repo. Humans should start with README.md and docs/Home.md.

## Project summary

Civitas helps small and medium government contractors find compatible RFPs. A Python + Playwright
scraping pipeline (webscraping/v2) collects opportunities from 60+ California procurement portals
(Cal eProcure, PlanetBids, BidSync, OpenGov) and writes manifests to S3. A Next.js 16 app
(front_end/) serves the UI and API routes, stores profiles and the RFP cache in Postgres (Drizzle,
pgvector, pg_trgm), and scores each RFP against a company profile with the v2 matcher
(front_end/src/lib/matching-v2.ts). Production runs on Vercel (app) and AWS (RDS, S3, DynamoDB,
Lambda, EventBridge).

## Repo map

- front_end/ - Next.js app: pages and API routes in src/app, shared code in src/lib, Drizzle schema and migrations in src/db, one-off tsx scripts in scripts/.
- webscraping/v2/ - current scraping system: scrapers/, pipeline/ (normalize, enrich), orchestrator/runner.py (CLI), agents/ (Claude-driven discovery/investigation), deploy/ (Lambda Dockerfile, SAM template, CodeBuild), tests/.
- webscraping/ (top level, outside v2) - retired v1 scripts and historical CSV/JSON exports; see docs/Retired-Features.md.
- infra/ - AWS resources: DynamoDB KPI tables (kpi-tables.yaml) and the daily-roundup Lambda (notifications/).
- outreach/ - user-discovery scripts (contact scraping, SMTP cold email). Contact CSVs are generated locally and gitignored.
- tests/ - standalone PDF parsing benchmark (pdf_parsing_benchmark.py) and its report.
- docs/ - project wiki (architecture, matching, security, KPIs); docs/test-profiles/ holds QA PDFs.
- .github/workflows/ - manual-only workflows: scrape.yml (scraping fallback) and investigate.yml (portal investigation agent).
- civitas.config.json - operational settings (LLM provider/model, auth, rate limits, cache, upload, KPI tables).
- docker-compose.yml - local Postgres 16 with pgvector.
- RFP_Parsing.py - retired v1 utility.

## Setup

Frontend (from repo root):

```bash
docker compose up -d postgres
cd front_end
cp .env.example .env.local   # then fill in values
npm install
npm run db:migrate
```

Scraper (Python 3.11 is what CI uses):

```bash
pip install -r webscraping/v2/requirements.txt
playwright install chromium
```

webscraping/requirements.txt is the old v1 (Selenium) dependency list; use the v2 file.

## Run, test, lint

Frontend (run inside front_end/):

- `npm run dev` - dev server at http://localhost:3000
- `npm run build` - production build
- `npm run lint` - ESLint (eslint.config.mjs, Next core-web-vitals + TypeScript rules)
- Tests: there is no `test` script. Unit tests in src/lib/__tests__/ use node:test and run with `npx tsx --test src/lib/__tests__/<file>.test.ts`.
- Typecheck: no script is defined; tsconfig.json has `strict: true`, and `npm run build` typechecks.
- DB: `npm run db:generate` (new migration from src/db/schema.ts), `npm run db:migrate`, `npm run db:studio`. `db:push` skips migration files; dev only.

Scraper (run from repo root so `webscraping.v2` imports resolve):

- `python -m webscraping.v2.orchestrator.runner --list` - list registered sites (no network)
- `python -m webscraping.v2.orchestrator.runner --site <site_id> --skip-upload` - scrape one site without writing to S3 (still hits the live portal; see guardrails). Also `--skip-enrich`, `-v`.
- Tests: `python -m pytest webscraping/v2/tests/test_unit.py -v` (no network). pytest is not listed in requirements.txt; install it separately.
- No Python linter or formatter is configured.

## Environment variables

Names only; never copy real values into code or docs. Templates: front_end/.env.example (copy to front_end/.env.local) and outreach/.env.example (copy to outreach/.env).

- Frontend: DATABASE_URL, JWT_SECRET (min 32 chars), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET, GROQ_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY (whichever providers civitas.config.json uses), VOYAGE_API_KEY, RESEND_API_KEY, CIVITAS_FROM_EMAIL, CIVITAS_CRON_SECRET, CIVITAS_APP_ORIGIN. Optional: ANTHROPIC_MODEL, CRON_SECRET, SKIP_EMAIL_VERIFICATION, CIVITAS_SES_SNS_TOPIC_ARN.
- Scraper: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_STORAGE_BUCKET_NAME, AWS_S3_REGION_NAME, ANTHROPIC_API_KEY, GROQ_API_KEY, LLM_PROVIDER, PLANETBIDS_USERNAME, PLANETBIDS_PASSWORD, SCRAPINGBEE_API_KEY, DAILY_BUDGET_USD. See webscraping/v2/config.py.
- Outreach: SMTP_EMAIL, SMTP_PASSWORD, SMTP_HOST, SMTP_PORT.

In development, email helpers log to the console when RESEND_API_KEY is unset.

## Conventions

- Frontend is TypeScript (strict), React 19, Tailwind CSS 4, App Router. Import from src with the `@/` alias.
- Operational settings belong in civitas.config.json (read by front_end/src/lib/config.ts); secrets come only from env vars.
- Schema changes: edit front_end/src/db/schema.ts, then `npm run db:generate`; do not hand-write files in src/db/migrations/meta/.
- AWS clients use the default credential provider chain; never pass keys inline (docs/Security.md).
- Scrapers subclass webscraping/v2/scrapers/base.py and are registered in SITE_REGISTRY in orchestrator/runner.py.
- Read docs/Retired-Features.md before deleting code that looks unused.

## Guardrails

- Never commit .env, .env.local, keys or tokens. Only .env.example templates are tracked.
- Do not deploy, run `aws` CLI commands, invoke Lambdas, edit EventBridge schedules, or run anything in webscraping/v2/deploy/ or infra/ against AWS without asking. Pushing to main deploys to Vercel production.
- Do not run scrapers, agents, or outreach scripts against live portals or real inboxes without asking. Prefer `--list`, unit tests, and `--skip-upload`. Never run outreach/send_emails.py except in dry-run mode, and only when asked.
- Do not run `npm run db:migrate`/`db:push` or backfill scripts against any DATABASE_URL other than the local docker-compose database.
- Do not commit scraper output: webscraping/downloads/, out.json, ad-hoc manifests.
- Generated files (do not hand-edit): front_end/package-lock.json, front_end/src/db/migrations/** (drizzle-kit), front_end/next-env.d.ts, front_end/.next/, front_end/src/data/naics-substitutes.json (scripts/naics-substitutes/).
- outreach/contacts*.csv contain real people's contact details. They are gitignored; never commit them or copy them elsewhere.

## Deeper docs

- docs/Home.md - wiki index
- docs/Frontend.md, docs/Backend.md - app structure, API routes, schema, S3 layout
- docs/Architecture-v2.md - design spec; section 4 is the table source of truth
- docs/Matching-Algorithm-v2.md - production matcher
- docs/Security.md - implemented controls
- docs/KPIs.md - event taxonomy and funnel CLI
- webscraping/v2/README.md, webscraping/v2/COVERAGE.md - scraper system and per-source coverage
- front_end/src/db/README.md - database workflow
- infra/README.md, infra/notifications/README.md - AWS resources
