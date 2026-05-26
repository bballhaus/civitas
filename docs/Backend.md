# Backend Architecture

Civitas's backend is a set of **Next.js API routes** that handle authentication, contract management, profile storage, RFP matching, and LLM-powered document extraction. User and matching data is stored in **Postgres** (via Drizzle ORM); raw uploaded files, scraped RFP manifests, and KPI aggregates live in **AWS S3**. KPI events live in **DynamoDB**. The backend runs as part of the same Next.js application as the frontend, deployed on **Vercel**; Postgres runs on **AWS RDS**.

## Tech Stack

| Technology | Purpose |
|---|---|
| Next.js 16.2 | API routes (serverless functions on Vercel) |
| jose 6.2 | JWT signing & verification (HS256) |
| bcryptjs 3.0 | Password hashing (12 rounds) |
| drizzle-orm + postgres | Postgres ORM and driver |
| @aws-sdk/client-s3 3.x | AWS S3 client |
| @aws-sdk/client-dynamodb 3.x | KPI event log + per-user summary tables |
| @aws-sdk/client-ses 3.x | (Bounce/complaint webhook only — outbound mail uses Resend) |
| resend 6.x | Transactional email (verification, password reset, daily roundup) |
| Provider-agnostic LLM (`lib/llm.ts`) | Groq, OpenAI, Anthropic — switch via `civitas.config.json` |
| mupdf | PDF text extraction (replaces pdf-parse) |
| mammoth 1.12 | DOCX text extraction |

## Directory Structure

```
front_end/src/
├── app/api/                           # API route handlers
│   ├── auth/
│   │   ├── login/route.ts             # POST — authenticate, return JWT
│   │   ├── signup/route.ts            # POST — create user, return JWT
│   │   ├── logout/route.ts            # POST — client-side token discard
│   │   ├── me/route.ts                # GET — current user (optional profile)
│   │   └── change-password/route.ts   # POST — change password
│   ├── contracts/
│   │   ├── route.ts                   # GET list, POST create (with extraction)
│   │   ├── [id]/route.ts              # GET, PATCH, DELETE single contract
│   │   └── extract/route.ts           # POST — extract metadata (no save)
│   ├── profile/
│   │   ├── route.ts                   # GET, PATCH profile
│   │   ├── extract/route.ts           # POST — multi-doc profile extraction
│   │   └── refresh/route.ts           # POST — recompute from contracts
│   ├── user/
│   │   ├── rfp-status/route.ts        # PATCH — track applied/in-progress RFPs
│   │   ├── generated-poe/route.ts     # GET — saved Plan of Execution
│   │   └── generated-proposal/route.ts # GET — saved Proposal
│   ├── events/route.ts                # GET — scraped RFP events from S3
│   ├── generate-proposal/route.ts     # POST — LLM proposal generation
│   ├── generate-plan-of-execution/route.ts
│   ├── match-summary/route.ts
│   ├── rfp-requirements-summary/route.ts
│   └── capabilities-analysis/route.ts
├── lib/                               # Shared server-side logic
│   ├── auth.ts                        # JWT signing/verification, password hashing
│   ├── s3.ts                          # S3 client (singleton, lazy-init)
│   ├── user-data.ts                   # User JSON CRUD with in-memory cache
│   ├── contract-storage.ts            # Contract CRUD operations
│   ├── profile-storage.ts             # Profile read/write/aggregate
│   ├── extraction.ts                  # LLM document extraction
│   ├── rfp-status.ts                  # RFP application tracking
│   └── rate-limit.ts                  # Rate limiting utility
└── proxy.ts                           # Edge proxy: rate limiting
```

## Security

### Authentication
- **Stateless JWT** (HS256) via the `jose` library
- `JWT_SECRET` must be set as an environment variable (server throws on missing/default)
- Token expiry: **7 days** (configurable via `auth.jwtExpiryDays` in `civitas.config.json`)
- Passwords hashed with **bcrypt (12 rounds)**
- Password requirements: 8+ chars, uppercase, lowercase, special character
- Legacy Django PBKDF2 hashes are transparently migrated to bcrypt on login

### Rate Limiting
Rate limiting is enforced at the edge via `proxy.ts` (Next.js proxy), with limits sourced from `civitas.config.json`:
- **Auth endpoints** (`/api/auth/*`): 10 requests per minute per IP
- **Profile extraction** (`/api/profile/extract`): 5 requests per minute per IP
- Returns `429 Too Many Requests` with `Retry-After` header when exceeded

Individual auth routes apply additional stricter sliding-window limits via `lib/rate-limit.ts` (login, signup, forgot-password) — see [Security & Optimization](Security.md).

### Security Headers
All responses include:
- `Strict-Transport-Security` (HSTS, 2 years, includeSubDomains, preload)
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy` (restrictive: self + S3 + Groq API only)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` (camera, microphone, geolocation disabled)

### File Upload Validation
- Maximum file size: **25 MB**
- Allowed extensions: `.pdf`, `.docx`, `.doc`, `.txt`
- Maximum files per batch extraction: **10**
- Validation runs before any processing or S3 upload

## Storage Architecture

User and matching data live in **Postgres** (AWS RDS, `db.t4g.micro`); raw files, scraped manifests, and KPI aggregates live in **S3**; KPI events live in **DynamoDB**.

```
Postgres (civitas-postgres)
├── users, profiles                     # auth + onboarding fields
├── specialties, capabilities, licenses, certifications, work_areas, agency_relationships
├── contracts, claims                   # uploaded evidence + extracted provenance
├── match_state                         # per-(user, rfp) status, score, feedback
├── generated_documents                 # POE / proposal drafts
├── rfp_cache, rfp_bidders, vendors     # denormalized read view of scraped manifests
└── pgvector + pg_trgm extensions       # semantic match + fuzzy vendor search

S3 (civitas-ai)
├── uploads/{user_id}/{contract_id}/    # raw uploaded files
├── scrapes/v2/{source}/                # versioned scrape manifests, vendor index, health
└── metrics/aggregate/                  # rolled-up KPI snapshots

DynamoDB
├── civitas-kpi-events                  # raw append-only event log (TTL 90d)
└── civitas-kpi-users                   # per-user aggregate counters + funnel checkpoints
```

See [Architecture-v2 § 3-4](Architecture-v2.md) for the Postgres schema and [front_end/src/db/README.md](../front_end/src/db/README.md) for migration commands.

### Caching
- The `lib/events-cache.ts` layer caches scraped RFP reads from S3 for the configured `cache.s3TtlMs` (default 5 min).
- Drizzle queries are not cached client-side — Postgres + connection pooling handles repeat-read latency.

## API Endpoints

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/signup/` | No | Create account, return JWT |
| POST | `/api/auth/login/` | No | Authenticate, return JWT |
| POST | `/api/auth/logout/` | Bearer | Client-side token discard |
| GET | `/api/auth/me/` | Bearer | Current user (`?include_profile=1` for full profile) |
| POST | `/api/auth/change-password/` | Bearer | Change password (requires current password) |

Auth responses include `Cache-Control: no-store` to prevent token caching.

### Contracts

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/contracts/` | Bearer | List all contracts (cached 30s) |
| POST | `/api/contracts/` | Bearer | Upload contract with optional extraction |
| GET | `/api/contracts/{id}/` | Bearer | Single contract details |
| PATCH | `/api/contracts/{id}/` | Bearer | Update metadata or file |
| DELETE | `/api/contracts/{id}/` | Bearer | Delete contract and S3 files |

### Profile

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/profile/` | Bearer | Fetch profile from S3 |
| PATCH | `/api/profile/` | Bearer | Update profile fields |
| POST | `/api/profile/refresh/` | Bearer | Recompute from all contracts |
| POST | `/api/profile/extract/` | No* | Multi-doc extraction for onboarding |

*Rate limited to 5 req/min per IP.

### RFP Status & Generation

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| PATCH | `/api/user/rfp-status/` | Bearer | Track applied/in-progress, save generated docs |
| GET | `/api/user/generated-poe/` | Bearer | Saved Plan of Execution (`?rfp_id=`) |
| GET | `/api/user/generated-proposal/` | Bearer | Saved Proposal (`?rfp_id=`) |
| GET | `/api/events/` | No | Scraped RFP events (S3-cached 5min, CDN-cached 5min) |

## LLM Document Extraction

Goes through the provider-agnostic `lib/llm.ts` `chatCompletion` layer. Provider is selected by `civitas.config.json` — Groq / OpenAI / Anthropic. Front-end document extraction defaults to Groq (`llama-3.1-8b-instant`); scraping pipeline enrichment runs Claude Haiku 4.5 with prompt caching (see [webscraping/v2/README.md](../webscraping/v2/README.md)).

### Supported Formats
- **PDF**: Text extracted via `mupdf`
- **DOCX**: Text extracted via `mammoth`
- **TXT**: Read directly as UTF-8

### Pipeline
1. Validate file size (≤25 MB) and type (.pdf, .docx, .doc, .txt)
2. Extract raw text (capped at 50,000 characters)
3. Send to the configured LLM with structured extraction prompt
4. Parse and normalize the JSON response
5. Return structured metadata or save as contract + claims (see [Architecture-v2 § 6](Architecture-v2.md))

## Environment Variables

```
JWT_SECRET=...                # Required. Strong random value for JWT signing.
DATABASE_URL=postgres://...   # Required. Postgres connection string.
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=civitas-ai
GROQ_API_KEY=...              # Provider keys; set whichever match civitas.config.json.
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
RESEND_API_KEY=...            # Required to actually send transactional email.
CIVITAS_FROM_EMAIL=...        # e.g. "Civitas <register@civitas-ai.net>"
```

## Deployment

Deployed on **Vercel** at `civitas-ai.net`. All API routes run as serverless functions. Environment variables configured in Vercel dashboard. Postgres runs on AWS RDS (`civitas-postgres`, us-east-1).
