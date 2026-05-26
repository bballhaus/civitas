# Civitas Wiki

**Civitas** is a California government RFP matching platform that helps contractors discover, evaluate, and respond to government contract opportunities. The system uses AI-powered matching to score RFPs against company profiles, and generates tailored proposals and execution plans.

## Documentation

### Architecture
- **[Frontend Architecture](Frontend)** — Next.js app structure, pages, API routes, state management, and UI flows
- **[Backend Architecture](Backend)** — Next.js API routes, S3 storage model, JWT authentication, LLM extraction, and API endpoints

### Product
- **[Key Features](Key-Features)** — End-to-end explanation of each major feature: RFP discovery, profile building, matching, proposal generation, status tracking, and web scraping pipeline
- **[Matching Algorithm (v1)](Matching-Algorithm)** — The shipping v1 client-side matcher: 3-stage pipeline, 10 scoring categories, synonym expansion, canonicalization
- **[Architecture v2](Architecture-v2)** — Working spec for the source-aware v2 matcher, Postgres schema, claims-based extraction, onboarding flow, and incumbent state machine
- **[Matching Values](Matching-Values)** — The dimensions of fit between a contractor and an RFP; what the algorithm should optimize for
- **[Matching Fine-Tuning](Matching-Finetuning)** — Plan for empirically learning the v2 dimension weights from user application behavior

### Security
- **[Security & Optimization](Security)** — Full security audit results, all implemented controls (nonce CSP, HttpOnly cookies, rate limiting, SSRF protection, LLM safety, SES email), and remaining work

### Analytics
- **[KPIs](KPIs)** — Event taxonomy, DynamoDB schema, signup + onboarding funnel definitions, and the `npm run kpi:funnel` CLI report

### Operations
- **[TODO](TODO)** — Remaining work for market readiness

### Testing
- **[Example Test Profiles](Example-Test-Profiles)** — Ready-made company profiles with test PDFs for verifying extraction and matching

## Quick Links

| Component | Dev URL | Prod URL |
|---|---|---|
| App | `localhost:3000` | `civitas-ai.net` |
| S3 Bucket | — | `civitas-ai` (us-east-1) |
| Postgres | docker-compose `postgres` service | RDS `civitas-postgres` (us-east-1) |

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Backend | Next.js API Routes (same deployment) |
| Auth | JWT (HS256, HttpOnly cookies, 7-day expiry) via jose + bcryptjs |
| Database | Postgres + Drizzle ORM, with `pgvector` (semantic match) and `pg_trgm` (fuzzy vendor search) |
| Object storage | AWS S3 (raw uploads, scraped manifests, KPI aggregates; SSE-S3, versioned) |
| Email | Resend (transactional: signup verification, password reset, daily roundup) |
| AI/LLM | Provider-agnostic via `civitas.config.json` (Groq / OpenAI / Anthropic); front-end uploads default to Groq, scraping enrichment defaults to Claude Haiku 4.5 |
| Scraping | Playwright, Python, PyMuPDF |
| Deployment | Vercel (frontend), AWS Lambda (scraping), AWS RDS (Postgres) |
