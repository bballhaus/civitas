# Backend Architecture

Civitas's backend is a set of **Next.js API routes** co-located with
the front end and deployed as Vercel serverless functions. User and
matching data lives in **Postgres** on RDS (via Drizzle ORM); raw
uploads, scraped manifests, and KPI daily snapshots live in **S3**;
KPI events live in **DynamoDB**. Scraping runs as a separate AWS
Lambda container — see
[`webscraping/v2/README.md`](../webscraping/v2/README.md).

## Tech Stack

| Technology | Purpose |
|---|---|
| Next.js 16.2 | API route handlers (serverless on Vercel) |
| jose 6.2 | JWT signing & verification (HS256) |
| bcryptjs 3.0 | Password hashing (12 rounds) |
| drizzle-orm + postgres | Postgres ORM and driver |
| `@aws-sdk/client-s3` | Raw uploads, scraped manifests, KPI snapshots, attachment proxy |
| `@aws-sdk/client-dynamodb` + `lib-dynamodb` | KPI event log + per-user summary |
| `@aws-sdk/client-ses` | (Bounce / complaint webhook only — outbound mail uses Resend) |
| resend 6.x | Verification, password reset, daily roundup |
| Anthropic SDK | NAICS tagger / critic, match summaries, contract classifier + extractor |
| `lib/llm.ts` provider-agnostic wrapper | Groq / OpenAI / Anthropic switch from `civitas.config.json` |
| mupdf | PDF text extraction |
| mammoth 1.12 | DOCX text extraction |

## Directory Structure

```
front_end/src/
├── app/api/                          # Route handlers
│   ├── auth/                         # login, signup, logout, me, verify-email, forgot-password, reset-password, change-password
│   ├── onboarding/                   # state (write step / finalize)
│   ├── profile/                      # full profile + per-entity routes:
│   │   ├── route.ts                  # GET, PATCH whole profile
│   │   ├── refresh/route.ts          # Recompute completeness + embeddings
│   │   ├── extract/route.ts          # Legacy bulk extractor (rate-limited)
│   │   ├── provenance/route.ts       # Per-field "evidenced by" claim lookup
│   │   ├── vendor/resolve/route.ts   # Claim a vendor fingerprint
│   │   └── {specialties,capabilities,licenses,certifications,work-areas,agency-relationships}/
│   │       └── route.ts + [id]/route.ts
│   ├── contracts/                    # v1 contracts CRUD + extraction
│   │   ├── route.ts, [id]/route.ts, extract/route.ts
│   │   ├── [id]/claims/route.ts, [id]/claims/[claimId]/route.ts
│   │   └── v2/route.ts, v2/list/route.ts
│   ├── match/                        # GET list + GET single, both v2
│   ├── match-summary, rfp-requirements-summary, capabilities-analysis/   # LLM detail-page summaries
│   ├── tracker/route.ts              # Pipeline + tasks for /home + /tracker
│   ├── tasks/route.ts, tasks/[id]/route.ts # Per-RFP task collection
│   ├── rfp-views/route.ts            # POST: mark match_state.viewed_at
│   ├── user/
│   │   ├── rfp-status/route.ts       # PATCH pipeline status + feedback
│   │   ├── dashboard-view/route.ts   # POST returns prior last-visit timestamp
│   │   ├── generated-poe/route.ts    # GET legacy POE markdown
│   │   └── generated-proposal/route.ts
│   ├── events/route.ts               # GET scraped RFPs (S3-cached)
│   ├── events/track/route.ts         # POST client KPI ingest (allowlisted types only)
│   ├── attachments/[...key]/route.ts # Signed-URL S3 attachment proxy
│   ├── cron/                         # All Bearer-protected via CIVITAS_CRON_SECRET
│   │   ├── daily-roundup/route.ts    # Hourly; sends roundup email at each user's local 7am
│   │   ├── sync-rfp-cache/route.ts   # Post-scrape: populate rfp_cache + tag + embed
│   │   ├── critique-rfp-tags/route.ts # Daily Sonnet audit of Haiku NAICS tags
│   │   └── rebuild-match-state/route.ts # Disaster-recovery rescore
│   ├── admin/                        # Admin-gated (lib/admin-auth.ts)
│   │   ├── kpis/route.ts, kpis/timeseries/route.ts
│   │   ├── events/route.ts
│   │   └── aggregate-kpis/route.ts   # Cron-secret-protected; recomputes daily snapshot
│   ├── email/ses-events/route.ts     # Legacy SES bounce / complaint webhook
│   ├── generate-proposal/route.ts    # Backend retained; no live UI caller (see Retired Features)
│   └── generate-plan-of-execution/route.ts
├── lib/                              # Shared server-side logic — see Frontend.md for the full list
└── proxy.ts                          # Edge proxy: rate limiting + per-request nonce CSP
```

## Security

### Authentication

- **Stateless JWT** (HS256) via `jose`.
- `JWT_SECRET` is required, must be ≥32 chars, and the server refuses
  to boot on placeholder values.
- JWT stored in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; JS
  cannot read it. Logout clears server-side (`Max-Age=0`).
- Token expiry: 7 days, sourced from `auth.jwtExpiryDays` in
  `civitas.config.json`.
- Passwords hashed with bcrypt (12 rounds). Django PBKDF2 hashes from
  the legacy back end are transparently re-hashed to bcrypt on first
  login.
- Email verification is mandatory in production via Resend (token in
  `pending_users.verification_token`); a `SKIP_EMAIL_VERIFICATION=true`
  env flag bypasses for the test cohort.

### Rate Limiting

Edge-level via `proxy.ts`, with limits from `civitas.config.json`:

- `/api/auth/*` — 10 req/min/IP
- `/api/profile/extract` — 5 req/min/IP

Route-level via `lib/rate-limit.ts`:

- Login — 5 attempts / 15 min / IP
- Signup — 5 attempts / 15 min / IP
- Forgot password — 3 attempts / 15 min / IP

Returns `429` with `Retry-After`.

### Security Headers

Set in `next.config.ts` / `proxy.ts`:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy` — nonce-based `script-src 'self' 'nonce-{...}'`;
  `style-src` retains `'unsafe-inline'` for Tailwind v4 (pending upstream)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `X-Permitted-Cross-Domain-Policies: none`

### File Upload Validation

Validated before any S3 write or LLM call:

- Max file size: 25 MB
- Allowed extensions: `.pdf`, `.docx`, `.doc`, `.txt`
- Magic-byte check (`%PDF`, `PK` for DOCX/ZIP, OLE header for DOC)
- Max files per batch (legacy `/api/profile/extract`): 10

### LLM Safety

All LLM calls separate system + user messages — uploaded document text
never lands inside the instruction prompt. The system message
explicitly instructs the model to ignore directives in user content.
Files: `lib/extraction.ts`, `lib/contract-pipeline-v2.ts`,
`lib/rfp-tagger.ts`, `lib/rfp-tag-critic.ts`,
`webscraping/v2/pipeline/enrich.py`.

PII redaction runs on every extracted text before LLM calls
(`lib/pii-redaction.ts`): SSN, EIN, phone, email, DL, signature, bank
account patterns are replaced with typed placeholders. The redacted
count is stored on `contracts.pii_redacted_count` for audit.

### Other Controls

See [Security & Optimization](Security) for the full matrix (SSRF
protection in the scraper, Docker non-root, S3 default credential
chain, ETag-based optimistic locking on user-data writes, security
event logging).

## Storage Architecture

```
Postgres (civitas-postgres on RDS, us-east-1)
├── users, pending_users, profiles
├── specialties, capabilities, licenses, certifications, work_areas, agency_relationships
├── contracts, claims                  # uploaded evidence + extracted provenance
├── match_state                        # per-(user, rfp) status, feedback snapshot, cached match
├── rfp_tasks                          # per-RFP checklist for the bidding tracker
├── generated_documents                # POE / proposal markdown (kept; no live writer today)
├── rfp_cache, rfp_bidders, vendors    # denormalized read view of scraped manifests
└── pgvector + pg_trgm extensions

S3 (civitas-ai, us-east-1; SSE-S3, versioned, public access blocked)
├── uploads/{user_id}/{contract_id}/     # raw uploaded files
├── scrapes/v2/{source}/                 # versioned scrape manifests, vendor index, health
├── metrics/aggregate/latest.json        # current KPI snapshot
├── metrics/aggregate/daily/{YYYY-MM-DD}.json   # per-day archive
└── system/email-index.json              # email-uniqueness index

DynamoDB (us-east-1, PAY_PER_REQUEST, SSE + PITR)
├── civitas-kpi-events   # raw append-only event log; TTL 90 days
└── civitas-kpi-users    # per-user aggregate counters + funnel checkpoints
```

The Postgres schema is the canonical source of truth — see
[`db/schema.ts`](../front_end/src/db/schema.ts) and
[Architecture-v2 § 4](Architecture-v2.md#4-postgres-schema). Notable
columns added since the original spec:

- `match_state.cached_score` / `cached_tier` / `cached_win_probability`
  / `cached_incumbent_state` / `match_data` / `scored_at` — live match
  cache (written only by the background rescore worker).
- `match_state.viewed_at` — first time the user opened the detail page;
  drives the daily roundup's "unviewed >75% matches" filter.
- `match_state.status_changed_at` — bidding-tracker audit.
- `match_state.status` enum widened to `'saved' | 'in_progress' |
  'bid_submitted' | 'won' | 'lost' | 'no_bid'`.
- `rfp_cache.scope_summary` (one-sentence LLM-generated scope),
  `qa_deadline`, `qa_response_date`, `prebid_meeting_at`,
  `site_visit_at`, `award_date`, `contract_start`, `contract_end`,
  `key_dates_sources` — per-event key dates extracted from attachments.
- `rfp_cache.naics_critiqued_at` — timestamp of the Sonnet critique
  pass; rows with `NULL` are picked up by the daily critic cron.
- `rfp_tasks` (new table) — per-(user, RFP) bidding checklist.

### Caching

- `lib/events-cache.ts` caches `/api/events` reads from S3 for the
  configured `cache.s3TtlMs` (default 5 min).
- Drizzle queries are not memoized client-side; Postgres + connection
  pooling handles repeat-read latency.

## API Endpoint Reference

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/signup/` | No | Write `pending_users`, send verification email |
| GET | `/api/auth/verify-email/` | Token | Promote `pending_users` → `users`, set JWT cookie |
| POST | `/api/auth/login/` | No | Authenticate, set JWT cookie |
| POST | `/api/auth/logout/` | Cookie | Clear JWT cookie |
| GET | `/api/auth/me/` | Cookie | Current user (`?include_profile=1` for full profile + pipeline buckets) |
| POST | `/api/auth/change-password/` | Cookie | Requires current password |
| POST | `/api/auth/forgot-password/` | No | Create reset token + email |
| POST | `/api/auth/reset-password/` | Token | Validate and apply new password |

Auth responses set `Cache-Control: no-store`.

### Profile (v2)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/profile/` | Full profile join (`FullProfile` shape) |
| PATCH | `/api/profile/` | Update `profiles.*` fields |
| POST | `/api/profile/refresh/` | Recompute completeness + queue embeddings |
| POST | `/api/profile/extract/` | Legacy multi-doc extraction (rate-limited) |
| GET | `/api/profile/provenance/` | Per-field "evidenced by" claim trail |
| POST | `/api/profile/vendor/resolve/` | Claim a vendor fingerprint by company-name match |
| `*` | `/api/profile/{specialties,capabilities,licenses,certifications,work-areas,agency-relationships}/[id]/` | Per-row CRUD |

### Contracts

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/contracts/v2/list/` | List contracts with pending / accepted claim counts |
| POST | `/api/contracts/v2/` | Upload → classify (Haiku) → extract (Sonnet) → claims |
| GET | `/api/contracts/[id]/claims/` | Claims for review |
| PATCH | `/api/contracts/[id]/claims/[claimId]/` | Accept / edit / reject |
| GET / POST / PATCH / DELETE | `/api/contracts/`, `/api/contracts/[id]/`, `/api/contracts/extract/` | Legacy contract paths |

### Match

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/match/` | v2 match list (reads `match_state.cached_*`; on-demand scoring + queued populate when missing) |
| GET | `/api/match/[rfpId]/` | Single match with breakdown + citations + `data_quality` + prime / sub tracks |
| POST | `/api/match-summary/` | LLM natural-language summary |
| POST | `/api/rfp-requirements-summary/` | LLM structured requirements summary |
| POST | `/api/capabilities-analysis/` | LLM capability-gap analysis |

### Tracker

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/tracker/` | Pipeline RFPs + tasks for `/home` + `/tracker` |
| PATCH | `/api/user/rfp-status/` | Status / feedback updates; auto-seeds default tasks on first save |
| GET / POST | `/api/tasks/` | List by `?rfp_id=` or all; create |
| GET / PATCH / DELETE | `/api/tasks/[id]/` | Toggle complete, rename, set due date, delete |
| POST | `/api/rfp-views/` | Set `match_state.viewed_at` (first view only) |
| POST | `/api/user/dashboard-view/` | Returns previous `last_dashboard_viewed_at`, atomically advances it |

### Events & RFPs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/events/` | No | Scraped RFP events (S3-cached 5 min, CDN-cached 5 min) |
| POST | `/api/events/track/` | Optional | Client KPI ingest; allowlists `CLIENT_EVENT_TYPES` only |
| GET | `/api/attachments/[...key]/` | Cookie | Signed-URL proxy for `uploads/...` and `scrapes/v2/.../attachments/...` |

### Cron

All `/api/cron/*` routes require `Authorization: Bearer
${CIVITAS_CRON_SECRET}`.

| Endpoint | Trigger | Purpose |
|---|---|---|
| `/api/cron/daily-roundup/` | EventBridge → Lambda shim hourly | Send the morning RFP digest at each user's local 7am, filtered to unviewed >75% matches |
| `/api/cron/sync-rfp-cache/` | Post-scrape (called from the scraping Lambda) | Populate `rfp_cache` from latest manifests, run Haiku NAICS tagger, refresh embeddings |
| `/api/cron/critique-rfp-tags/` | EventBridge → Lambda shim daily | Sonnet 4.6 audit of `rfp_cache.naics_critiqued_at IS NULL` rows; nulls `embedding` where Sonnet disagrees so the next embed sweep recomputes |
| `/api/cron/rebuild-match-state/` | Manual / disaster recovery | Re-run `matching-v2.ts` for every (user, RFP) and refresh `match_state.cached_*` |

### Admin

`/admin/kpis` is gated by `lib/admin-auth.ts` (JWT cookie + allowlist).

| Method | Endpoint | Description |
|---|---|---|
| GET / POST | `/api/admin/kpis/` | Read `metrics/aggregate/latest.json` / recompute on demand |
| GET | `/api/admin/kpis/timeseries/` | `?granularity=day|week|month` over the S3 daily archive |
| GET | `/api/admin/events/` | `?type=...` raw event drill-down via DynamoDB `byEventType` GSI |
| POST | `/api/admin/aggregate-kpis/` | Cron-secret-protected; writes daily snapshot |

### Email

| Endpoint | Description |
|---|---|
| `/api/email/ses-events/` | Legacy SES bounce / complaint webhook with SNS signature verification. No new mail goes through SES — see [Retired Features](Retired-Features). |

## LLM Document Extraction

Three live pipelines:

1. **Legacy multi-doc extractor** (`lib/extraction.ts` →
   `/api/profile/extract`): defaults to Groq
   (`llama-3.1-8b-instant`) per `civitas.config.json`. Used by
   `/upload`.
2. **v2 single-contract pipeline** (`lib/contract-pipeline-v2.ts` →
   `/api/contracts/v2`): Haiku 4.5 classifier (with the
   `rfp_solicitation` guardrail) plus Sonnet 4.6 targeted extractor.
   Outputs a claims array; review at `/contracts/[id]/review`.
3. **Scraping enrichment**
   ([`webscraping/v2/pipeline/enrich.py`](../webscraping/v2/pipeline/enrich.py)):
   Anthropic Haiku 4.5 default, Groq fallback via `LLM_PROVIDER=groq`.
   Outputs NAICS, certs, licenses, clearances, deliverables, key dates,
   incumbent vendor / contract end. PII redaction + SSRF protection in
   the same module.

### Supported Formats

- **PDF** via `mupdf`
- **DOCX** via `mammoth`
- **TXT** read directly as UTF-8

### Pipeline

1. Validate file size + type
2. Extract raw text (capped at 50,000 characters)
3. PII redact
4. Classify (v2 only) — Haiku 4.5
5. Extract per-type (v2: Sonnet 4.6; legacy: Groq)
6. Persist (v2: `contracts` + `claims`; legacy: flat profile fields)
7. UI review (v2 only — `/contracts/[id]/review`)

## Environment Variables

See [Frontend Architecture § Development](Frontend.md#development) for
the full list. Server-side required:

```
JWT_SECRET=...
DATABASE_URL=postgres://...
ANTHROPIC_API_KEY=...        # NAICS tagger / critic, contract pipeline, summaries
VOYAGE_API_KEY=...           # rfp_cache + profile embeddings
RESEND_API_KEY=...           # Outbound mail
CIVITAS_FROM_EMAIL=...
CIVITAS_CRON_SECRET=...      # /api/cron/* Bearer
CIVITAS_APP_ORIGIN=...       # Email link base
AWS_ACCESS_KEY_ID=..., AWS_SECRET_ACCESS_KEY=..., AWS_REGION=us-east-1, AWS_S3_BUCKET=civitas-ai
GROQ_API_KEY=...             # Optional (legacy front-end extractor + scraping fallback)
OPENAI_API_KEY=...           # Optional (provider-agnostic LLM layer)
```

## Deployment

Deployed on **Vercel** at `civitas-ai.net`. All API routes run as
serverless functions. Environment variables configured in the Vercel
dashboard. Postgres runs on AWS RDS (`civitas-postgres`,
`db.t4g.micro`, us-east-1).

Cron infrastructure (see [`infra/notifications/`](../infra/notifications/)):

- EventBridge `rate(1 hour)` → `civitas-daily-roundup` Lambda → POST
  `/api/cron/daily-roundup/`.
- EventBridge daily → reuse the same Lambda shim with
  `CIVITAS_CRON_URL` pointed at `/api/cron/critique-rfp-tags/`.
- Scraping Lambda
  ([`webscraping/v2/deploy/template.yaml`](../webscraping/v2/deploy/template.yaml))
  on `rate(48 hours)` plus a daily `cron(0 13 * * ? *)` exploration /
  onboarding rule. After each batch the Lambda POSTs
  `/api/cron/sync-rfp-cache/`.
