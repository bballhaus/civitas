# Civitas

Civitas reduces the time it takes small and medium government
contractors to find compatible RFPs. It aggregates procurement
opportunities from 60+ California government sites and uses
source-aware semantic matching plus a per-RFP citation breakdown to
surface the highest-fit opportunities — see
[Key Features](docs/Key-Features.md) for the live product.

## Documentation

Start with [Home](docs/Home.md).

- [Frontend Architecture](docs/Frontend.md)
- [Backend Architecture](docs/Backend.md)
- [Architecture v2](docs/Architecture-v2.md) — largely shipped; remaining items inline
- [Key Features](docs/Key-Features.md)
- [Matching Algorithm v2](docs/Matching-Algorithm-v2.md) — the production matcher
- [Matching Values](docs/Matching-Values.md)
- [Matching Fine-Tuning](docs/Matching-Finetuning.md) — weight-learning roadmap
- [Security & Optimization](docs/Security.md)
- [KPIs](docs/KPIs.md)
- [Retired Features](docs/Retired-Features.md)
- [TODO](docs/TODO.md)
- [Matching Algorithm v1 (historical)](docs/Matching-Algorithm.md) — retired
- [Example Test Profiles](docs/Example-Test-Profiles.md)

## Architecture

| Component | Technology | Deployment |
|-----------|-----------|------------|
| Frontend + API | Next.js 16 (App Router) | Vercel |
| Auth | bcrypt + JWT (HttpOnly cookies) | Vercel serverless |
| Database | Postgres + Drizzle (RDS, with `pgvector` + `pg_trgm`) | AWS us-east-1 |
| Object storage | S3 (`civitas-ai` bucket, SSE-S3 encrypted, versioned) | AWS us-east-1 |
| Email | Resend (transactional) | API |
| LLM | Provider-agnostic (Groq / OpenAI / Anthropic) via `civitas.config.json` | API |
| PDF enrichment (scraping) | Claude Haiku 4.5 (default) with prompt caching; Groq fallback | API |
| KPI events | DynamoDB (`civitas-kpi-events`, `civitas-kpi-users`) | AWS us-east-1 |
| Scraping | Playwright + Python | AWS Lambda (container, non-root) |
| Scheduling | EventBridge | Scraping `rate(48 hours)`; daily roundup Lambda `rate(1 hour)` |

## Project Structure

```
civitas/
├── front_end/              # Next.js app (frontend + API routes)
│   ├── src/app/            # Pages and API routes
│   ├── src/lib/            # Shared libraries (auth, S3, extraction, email)
│   ├── src/proxy.ts        # Edge proxy: nonce-based CSP + rate limiting
│   └── package.json
├── webscraping/            # RFP scraping system
│   └── v2/                 # Multi-source scraping pipeline
│       ├── scrapers/       # Site-specific scrapers (Cal eProcure, PlanetBids, BidSync)
│       ├── pipeline/       # Normalize + enrich pipeline (SSRF-protected)
│       ├── orchestrator/   # CLI runner + site registry
│       └── deploy/         # Lambda, Dockerfile, EventBridge, CodeBuild
├── docs/                   # Project documentation
└── .github/workflows/      # CI/CD and manual scraping fallback
```

## Security

| Control | Implementation |
|---------|---------------|
| Authentication | JWT in HttpOnly/Secure/SameSite=Strict cookies (7-day expiry) |
| Password hashing | bcrypt (12 rounds) |
| CSP | Nonce-based script-src (no `unsafe-inline` or `unsafe-eval`) |
| Rate limiting | Sliding window: 5 req/15min on auth, 3/15min on password reset |
| File uploads | Extension + magic byte validation (PDF, DOCX, DOC, TXT) |
| Input validation | Regex-validated RFP IDs, sanitized S3 keys |
| LLM safety | System/user message separation (prompt injection mitigation) |
| SSRF protection | URL validation blocks private IPs, metadata endpoints |
| S3 security | Encryption at rest (SSE-S3), versioning, public access blocked, ETag optimistic locking |
| Credentials | Default AWS credential provider chain (no hardcoded keys) |
| Container | Non-root user in Lambda Docker image |
| Email verification | Token-based via Resend (auto-verified in dev mode if no `RESEND_API_KEY`) |
| Security logging | Structured JSON for all auth events |
| Security headers | HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, X-Permitted-Cross-Domain-Policies |

## Scraping Coverage

60+ California procurement sites across four platforms:

- **Cal eProcure** (1) — California state-level procurement; full pipeline including inline PDF download and LLM-extracted requirements
- **PlanetBids** (43 agencies) — cities and counties including San Diego, Sacramento, Fresno, Anaheim, Riverside; market intel (prospective bidders / bid results / awards) via shared cross-portal vendor login; PDFs gated per-agency (`vendor_registered=True` unlocks the Documents tab)
- **BidSync / Periscope** (15 agencies) — counties and special districts; search-result metadata only (detail pages require login)
- **OpenGov Procurement** — direct JSON API at `api.procurement.opengov.com`; currently blocked by Cloudflare on the listing host
- **Agentic** (LA City, SF City) — disabled in the registry pending Lambda fixes

See [webscraping/v2/README.md](webscraping/v2/README.md) for the scraping system and [webscraping/v2/COVERAGE.md](webscraping/v2/COVERAGE.md) for the per-source field matrix.

## Local Development

### Frontend

```bash
cd front_end
npm install
npm run dev     # http://localhost:3000
```

Environment variables needed in `front_end/.env.local`:
- `DATABASE_URL` (Postgres connection string; matches the docker-compose service for local dev)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET`
- `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (whichever providers are enabled in `civitas.config.json`)
- `JWT_SECRET` (min 32 chars)
- `RESEND_API_KEY`, `CIVITAS_FROM_EMAIL` (e.g. `Civitas <register@civitas-ai.net>`) for transactional email

The database runs locally via `docker compose up -d postgres`; see [front_end/src/db/README.md](front_end/src/db/README.md) for migration commands.

In development (`NODE_ENV=development`):
- Email helpers log to console when `RESEND_API_KEY` or `CIVITAS_FROM_EMAIL` is unset
- Password reset URLs are logged to console
- Cookies use `Secure=false` for localhost

### Email Setup (Resend)

```bash
# 1. Add your domain (e.g. civitas-ai.net) to the Resend dashboard and verify DNS.
# 2. Set env vars
RESEND_API_KEY=re_...
CIVITAS_FROM_EMAIL="Civitas <register@civitas-ai.net>"
```

### Scraping

```bash
pip install -r webscraping/v2/requirements.txt
playwright install chromium

# Run a specific site
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego --skip-upload

# List all sites
python -m webscraping.v2.orchestrator.runner --list
```

## Deployment

- **Frontend**: Push to `main` triggers Vercel deployment
- **Scraping**: `aws codebuild start-build --project-name civitas-scraper-build --source-version main` rebuilds the Lambda container
- **Schedule**: EventBridge rule `civitas-scrape-all` triggers Lambda on `rate(48 hours)`; a separate daily exploration / onboarding rule fires at `cron(0 13 * * ? *)`. The daily-roundup Lambda runs on `rate(1 hour)` so it can fire at each user's local 7am — see [infra/notifications/](infra/notifications/).
