# Civitas Wiki

**Civitas** is a California government RFP matching platform that helps
small / medium contractors discover compatible procurement opportunities
without spending days clicking through 57+ portals. The system scrapes
those portals nightly, scores every RFP against the user's onboarded
company profile, and surfaces a per-category breakdown that explains why
each score is what it is.

The product surface today is four pages:

- **Home** — pipeline counters, calendar, upcoming deadlines.
- **Matches** — v2 source-aware match list, with prime + sub tracks
  on the detail view.
- **Tracker** — bidding pipeline (saved / in progress / bid submitted /
  won / lost / no bid) with per-RFP task checklists and a full
  FullCalendar view.
- **Profile** — v2 section-by-section profile editor with provenance
  per field.

## Documentation

### Architecture

- **[Frontend Architecture](Frontend)** — Next.js 16 app, current pages
  and API routes, lib map, state model.
- **[Backend Architecture](Backend)** — Postgres schema overview, S3
  layout, DynamoDB, JWT auth, file validation, cron entry points.
- **[Architecture v2](Architecture-v2)** — The v2 design spec. Most of
  it has shipped; remaining work is flagged inline and in [TODO](TODO).

### Product

- **[Key Features](Key-Features)** — End-to-end walkthrough of each
  live feature: RFP discovery / matching, onboarding wizard,
  per-contract claim review, bidding tracker, daily roundup email.
- **[Matching Algorithm v2](Matching-Algorithm-v2)** — Source-aware
  pipeline, hard gates that fire only on non-empty data, embedding-based
  semantic match, incumbent state machine, prime / sub tracks,
  citations.
- **[Matching Values](Matching-Values)** — The dimensions of fit the
  matcher should optimize for. Authored before v2; still the north
  star.
- **[Matching Fine-Tuning](Matching-Finetuning)** — Plan for learning
  the v2 dimension weights empirically from application behavior.
  Logging infra not yet built; design only.

### Operations

- **[Security & Optimization](Security)** — Audit results, all
  implemented controls (nonce CSP, HttpOnly cookies, rate limiting,
  SSRF protection, LLM prompt-injection mitigation), and remaining
  work.
- **[KPIs](KPIs)** — Event taxonomy, DynamoDB schema, S3 daily
  snapshots, admin dashboard, funnel CLI.
- **[Retired Features](Retired-Features)** — Components that were
  replaced or hidden during the v1 → v2 rewrite. Read before deleting
  anything that looks unused.
- **[TODO](TODO)** — Remaining work for market readiness.

### Reference

- **[Matching Algorithm v1 (historical)](Matching-Algorithm)** —
  The retired client-side synonym-Jaccard scorer. Kept for
  context; not active code.
- **[Example Test Profiles](Example-Test-Profiles)** — Pre-built
  company PDFs + expected extraction targets for QA.

## Quick Links

| Component | Dev URL | Prod URL |
|---|---|---|
| App | `localhost:3000` | `civitas-ai.net` |
| S3 Bucket | — | `civitas-ai` (us-east-1) |
| Postgres | docker-compose `postgres` service | RDS `civitas-postgres` (us-east-1) |
| KPI dashboard | `localhost:3000/admin/kpis` | `civitas-ai.net/admin/kpis` (admin allowlist) |

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Backend | Next.js API Routes (same deployment) |
| Auth | JWT (HS256, HttpOnly cookies, 7-day expiry) via jose + bcryptjs |
| Database | Postgres + Drizzle ORM (RDS), `pgvector` for semantic match, `pg_trgm` for fuzzy vendor search |
| Object storage | AWS S3 (raw uploads, scraped manifests, KPI daily snapshots; SSE-S3, versioned) |
| KPI events | DynamoDB (`civitas-kpi-events`, `civitas-kpi-users`) |
| Email | Resend (verification, password reset, daily roundup). Legacy SES bounce webhook retained. |
| AI / LLM | Anthropic Haiku 4.5 default (scraping enrichment + NAICS tagging) with prompt caching; Sonnet 4.6 for the NAICS critic; Voyage-3-large 1024-dim for embeddings; Groq fallback for the legacy front-end extractor |
| Scraping | Playwright + Python on AWS Lambda (container, non-root) |
| Deployment | Vercel (frontend + API), AWS Lambda (scraping + cron shims), AWS RDS (Postgres) |
