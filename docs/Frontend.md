# Frontend Architecture

Civitas's frontend is a **Next.js 16** application (App Router) with
React 19, TypeScript, and Tailwind CSS 4. The same Next.js deployment
handles both the React UI and the API routes; everything ships to
Vercel.

The four navigation surfaces are `/home`, `/matches`, `/tracker`, and
`/profile/v2`. A handful of older routes (`/dashboard`, `/profile`,
`/profile-setup`) still resolve but are not linked from the header
navigation — see [Retired Features](Retired-Features).

## Tech Stack

| Technology | Purpose |
|---|---|
| Next.js 16.2 | React framework + server-side API routes |
| React 19.2 | UI rendering (uses the React Compiler) |
| TypeScript 5 | Type-safe development |
| Tailwind CSS 4 | Utility styling |
| Provider-agnostic LLM (`lib/llm.ts`) | Server-side LLM calls (Groq / OpenAI / Anthropic) |
| Anthropic SDK | Direct calls for NAICS tagging + critic (Haiku + Sonnet) |
| AWS SDK (S3 + DynamoDB) | KPI events, KPI snapshots, raw uploads, scraped manifests, attachment proxy |
| Drizzle ORM + Postgres | Users, profile, contracts, claims, match state, tracker tasks, RFP cache |
| Resend | Transactional email (verification, password reset, daily roundup) |
| mupdf | PDF text extraction |
| FullCalendar | Bidding-tracker calendar view |
| react-markdown | Rendering generated summaries |

## Directory Structure

```
front_end/src/
├── app/                              # Next.js App Router
│   ├── page.tsx                      # Root redirect → /login
│   ├── layout.tsx                    # Root layout (fonts, global CSS, nonce, prefetch)
│   ├── login/page.tsx                # Login form
│   ├── signup/page.tsx               # Registration + password rules
│   ├── forgot-password/, reset-password/  # Password reset flow
│   ├── onboarding/                   # 9-step v2 wizard (page.tsx + Steps.tsx + commit.tsx + types.ts)
│   ├── home/page.tsx                 # Overview (tracker counters + calendar + deadlines)
│   ├── matches/page.tsx              # v2 match list (filters, sort, pre-scored cache)
│   ├── matches/[rfpId]/page.tsx      # v2 detail (prime + sub tabs, citations, summaries)
│   ├── tracker/page.tsx              # Bidding pipeline + FullCalendar + tasks
│   ├── profile/v2/page.tsx           # v2 profile editor (section-by-section, reuses onboarding widgets)
│   ├── contracts/page.tsx            # v2 contracts list + upload
│   ├── contracts/[id]/review/page.tsx # v2 claim review (accept / edit / reject)
│   ├── admin/kpis/page.tsx           # Admin KPI dashboard (timeseries + drill-down)
│   ├── upload/page.tsx               # Legacy bulk-upload (transitional; see Retired Features)
│   ├── profile/page.tsx              # Legacy profile (retired)
│   ├── profile-setup/page.tsx        # Legacy first-time profile (retired)
│   ├── dashboard/                    # Legacy v1 dashboard + detail (retired; SHOW_AI_GENERATION=false)
│   └── api/                          # Server-side API routes (see Backend.md for the full list)
├── components/                       # AppHeader, MeshBackground, PrefetchEvents, LoadingScreen, MarkdownContent, KpiInit
├── lib/
│   ├── api.ts                        # Frontend API client (auth-cookied fetches)
│   ├── auth.ts                       # JWT signing / verification, getAuthenticatedUser, password hashing
│   ├── admin-auth.ts                 # /admin/* allowlist gate
│   ├── llm.ts                        # Provider-agnostic chatCompletion
│   ├── config.ts                     # Typed access to civitas.config.json
│   ├── s3.ts, dynamodb.ts            # AWS clients (lazy singleton)
│   ├── email.ts                      # Resend wrapper + dev console fallback
│   ├── email-index.ts                # S3 email-uniqueness index
│   ├── user-data.ts                  # Legacy S3 user JSON CRUD (POE / proposal markdown + match-feedback snapshot)
│   ├── contract-storage.ts           # Legacy contract metadata helpers
│   ├── contract-pipeline-v2.ts       # v2 classifier → extractor pipeline writing into Postgres claims
│   ├── profile-storage.ts            # Profile read / write / aggregate
│   ├── extraction.ts                 # Legacy front-end LLM extractor (/upload)
│   ├── pii-redaction.ts              # Regex PII redaction before any LLM call
│   ├── claim-acceptance.ts           # Apply accepted claims to profile rows
│   ├── rfp-status.ts                 # Legacy generated-doc storage (POE / proposal)
│   ├── rate-limit.ts                 # Sliding-window rate limiter
│   ├── rfp-matching.ts               # Legacy v1 matcher — type-only importer for v2 pages
│   ├── matching-v2.ts                # PRIMARY matcher: source-aware, prime / sub, citations
│   ├── match-rescore.ts              # Background rescore worker (writes match_state.cached_*)
│   ├── match-rescore-trigger.ts      # Fire-and-forget enqueue
│   ├── embeddings.ts                 # Voyage-3-large 1024-dim embedder + RFP / profile refresh
│   ├── naics-similarity.ts, profile-naics.ts # NAICS substitution + match helpers
│   ├── rfp-cache-populator.ts        # Refresh rfp_cache from scraped manifests
│   ├── rfp-tagger.ts                 # Haiku 4.5 NAICS tagger (primary + secondary + scope_summary)
│   ├── rfp-tag-critic.ts             # Sonnet 4.6 audit of the Haiku tags
│   ├── rfp-source-visibility.ts      # Hide gated sources from the match list
│   ├── parse-deadline.ts             # Robust deadline parsing
│   ├── kpi-aggregator.ts             # Daily KPI rollup → S3 (metrics/aggregate/)
│   ├── event-log.ts                  # Server-side recordEvent → DynamoDB
│   ├── event-tracker.ts              # Client-side trackEvent → /api/events/track
│   ├── events.ts                     # KPI event taxonomy (SERVER_EVENT_TYPES, CLIENT_EVENT_TYPES, counters, funnel)
│   ├── events-cache.ts               # Server-side RFP read cache
│   ├── capabilities.ts               # Capability normalization + synonyms
│   ├── rfp-portal.ts                 # Portal-label helpers
│   ├── sns-verify.ts                 # SES bounce SNS signature verification (legacy)
│   ├── security-log.ts               # Structured JSON log for auth events
│   ├── onboarding-data.ts            # Onboarding constants (LICENSE_CLASSES, DURATION_PREFS, STEP_META, ...)
│   └── test-users.ts                 # Test-account allowlist (excluded from KPI rollups)
├── db/                               # Drizzle schema, client, migrations, query modules
│   ├── schema.ts                     # All Drizzle table definitions
│   ├── client.ts                     # postgres-js connection pool
│   └── queries/                      # profile, match-state, rfp-tasks, pending-users, users
├── proxy.ts                          # Edge proxy: rate limiting + per-request nonce CSP
├── data/                             # filter-options.ts, california-counties.json, capabilities.json
└── types/                            # Type declarations
```

## Pages & User Flows

### Authentication

**Login** (`/login`) — Username/password form. On success the server
sets a JWT in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie and
redirects to `/home` (or `/onboarding` if the user hasn't completed
the wizard).

**Signup** (`/signup`) — Real-time password rule validation (8+ chars,
upper, lower, special). The signup route writes a `pending_users` row
and sends a verification email via Resend; clicking the link promotes
the row into `users` in a transaction. A development bypass flag
(`SKIP_EMAIL_VERIFICATION=true`) is supported for the test cohort.

### Onboarding (`/onboarding`)

9-step guided wizard (identity → specialties → capabilities → NAICS →
licenses → certifications → geography → scope & duration → capacity).
Each step's state is committed via the `CommitProvider` immediately
after every change, so the user can leave and resume mid-wizard. Step
widgets live in `app/onboarding/Steps.tsx` and are reused verbatim
inside `/profile/v2`.

Finish writes `profiles.onboarded_at` (via
`POST /api/onboarding/state/`). The default hand-off lands the user on
`/upload` (multi-doc backfill); in edit mode it returns to `/profile/v2`.

### Core Application

**Home** (`/home`) — Bidding-tracker overview. Quick stats grid for the
six pipeline buckets (Saved / In Progress / Bid Submitted / Won / Lost
/ No-Bid) plus a "Due in 30 days" tile, a mini calendar of upcoming
deadlines + tasks, and an "Upcoming deadlines" list. Stats and calendar
are fed by `GET /api/tracker`.

**Matches** (`/matches`) — v2 match list. Reads pre-scored matches
from `match_state.cached_*` (populated by the background rescore
worker) plus on-demand scoring for newly-cached RFPs. Filter chips
(industry, agency, value range, capabilities, contract type,
certifications, clearances, NAICS, cities, counties, size status,
deadline status), sort (match / deadline / value), incumbent chips,
`data_quality` badges (full / requirements-only / market-intel /
thin), and Save / Status actions inline.

**RFP Detail** (`/matches/[rfpId]`) — Prime + Sub track tabs. Each
scoring category renders its citation: the RFP phrase + the profile
claim that justified it. Sections expand to show LLM-generated
summaries (match summary, RFP requirements summary, capabilities
analysis). Save + pipeline-status actions persist via
`/api/user/rfp-status`. Good / bad match feedback (with optional
reason) persists into `match_state.feedback_*`. The page fires
`POST /api/rfp-views` once on mount to set `match_state.viewed_at` —
used by the daily roundup to skip already-viewed RFPs.

**Tracker** (`/tracker`) — FullCalendar view of every saved RFP plus
the per-RFP tasks. Status drag-and-drop, task creation / edit / delete,
column filters. Tasks are stored in `rfp_tasks`; the first save of any
RFP seeds a 7-item default checklist (review attachments, confirm
bid/no-bid, submit questions, pre-bid meeting, draft, internal review,
submit bid). Backed by `GET /api/tracker`, `/api/tasks/*`,
`/api/user/rfp-status`.

**Profile** (`/profile/v2`) — Section-by-section editor. Each section
renders the same widget the onboarding wizard uses, so adding a field
in onboarding automatically adds it in the profile editor. Inline
provenance ("evidenced by contract X") when the row came from an
accepted claim. Vendor-identity claim widget at top — when the user's
company name fuzzy-matches a row in the `vendors` table, they can
claim that fingerprint and auto-populate `agency_relationships`.

**Contracts** (`/contracts`) — Upload + list. Each upload runs the v2
classifier (Haiku → `document_type`) and a `document_type`-specific
extractor (Sonnet), writing every fact as a `claims` row with snippet
and confidence. The user is then redirected to `/contracts/[id]/review`
to accept / edit / reject the claims before they touch the profile.

**Admin KPIs** (`/admin/kpis`) — Internal dashboard. Admin allowlist
enforced server-side by `lib/admin-auth.ts`. Two surfaces: a snapshot
view (`/api/admin/kpis` GET reads the daily S3 snapshot; POST
re-runs the aggregator on demand) and a timeseries view
(`/api/admin/kpis/timeseries?granularity=day|week|month`). Drill-down
into raw events via `/api/admin/events?type=...`.

## API Routes

All routes are colocated under `front_end/src/app/api/`. See
[Backend Architecture](Backend) for the full reference; the highlights:

| Surface | Route | Notes |
|---|---|---|
| Auth | `/api/auth/{login,signup,logout,me,verify-email,forgot-password,reset-password,change-password}` | JWT in HttpOnly cookie |
| Onboarding | `POST /api/onboarding/state/` | Single endpoint — write the in-progress snapshot or finalize |
| Profile (v2) | `/api/profile/{specialties,capabilities,licenses,certifications,work-areas,agency-relationships}` | Per-entity CRUD with `[id]` sub-routes |
| Profile | `/api/profile/{,refresh,provenance,extract,vendor/resolve}` | `extract` is the legacy bulk LLM path; `vendor/resolve` claims a vendor fingerprint |
| Contracts (v2) | `/api/contracts/v2`, `/api/contracts/v2/list` | Server-side classifier + extractor + claim writes |
| Contracts | `/api/contracts/[id]/claims`, `/api/contracts/[id]/claims/[claimId]` | Claim review (accept / edit / reject) |
| Contracts | `/api/contracts/`, `/api/contracts/[id]/`, `/api/contracts/extract/` | Legacy contract paths |
| Match | `/api/match`, `/api/match/[rfpId]` | v2 scoring — list + detail |
| Match summaries | `/api/match-summary`, `/api/rfp-requirements-summary`, `/api/capabilities-analysis` | LLM-generated detail-page summaries (Anthropic) |
| Tracker | `/api/tracker`, `/api/tasks`, `/api/tasks/[id]` | Bidding pipeline + tasks |
| User state | `/api/user/rfp-status`, `/api/user/dashboard-view`, `/api/rfp-views` | Status changes, last-visit threshold, viewedAt |
| Events / RFPs | `/api/events`, `/api/events/track`, `/api/attachments/[...key]` | Reading scraped RFPs, client KPI ingest, signed-URL attachment proxy |
| Cron | `/api/cron/{daily-roundup,sync-rfp-cache,critique-rfp-tags,rebuild-match-state}` | Bearer-authed (`CIVITAS_CRON_SECRET`) |
| Admin | `/api/admin/{kpis,kpis/timeseries,events,aggregate-kpis}` | Admin-gated KPI surface |
| Email | `/api/email/ses-events` | Legacy SES bounce / complaint webhook |
| Legacy | `/api/generate-proposal`, `/api/generate-plan-of-execution`, `/api/user/generated-{poe,proposal}` | Backend kept; no live UI calls (see Retired Features) |

## API Client (`lib/api.ts`)

Centralized module for browser → API communication. Same-origin
requests so the auth cookie is sent automatically; the
`get/set/clearAuthToken` helpers are no-ops kept for backward
compatibility with code that hasn't been pruned.

**Auth / user**: `getCurrentUser()`, `getProfileFromBackend()`, `logout()`
**Profile**: `saveProfileToBackend()`, `uploadContractDocument()`,
`deleteContractDocument()`, `listContracts()`
**RFP status**: `updateUserRfpStatus()`, `setRfpStatus()`,
`getGeneratedPoe()`, `getGeneratedProposal()` (legacy)
**Tasks**: `listTasks()`, `createTask()`, `updateTask()`, `deleteTask()`
**Cache**: `getCachedUser()`, `setCachedUser()`, `getCachedProfile()`,
`setCachedProfile()`

`PipelineStatus` is the canonical bidding-pipeline enum:
`"saved" | "in_progress" | "bid_submitted" | "won" | "lost" | "no_bid"`.
The `PIPELINE_STATUSES` constant is the read-order for tracker columns.

## State Management & Caching

- **Auth cookie**: HttpOnly / Secure / SameSite=Strict JWT, set
  server-side. JS never sees the token.
- **localStorage**: cached profile snapshot, saved-RFP-IDs snapshot,
  UI preferences only — never the auth token.
- **In-memory cache**: user object and profile cached per session via
  `lib/api.ts` helpers.
- **Server-side RFP cache**: `lib/events-cache.ts` caches `/api/events`
  reads for `cache.s3TtlMs` (default 5 min).
- **Postgres `rfp_cache`**: denormalized read view of scraped
  manifests, refreshed by the `/api/cron/sync-rfp-cache` route.
- **`match_state.cached_*`**: per-(user, RFP) live match cache,
  populated by `lib/match-rescore.ts` after profile changes,
  scraping refresh, or NAICS critique edits.
- **`PrefetchEvents` component**: preloads RFP data on app mount.
- **React `useDeferredValue`**: keeps filter-chip changes from
  blocking the UI on `/matches`.

## Development

```bash
cd front_end
npm install
npm run dev        # Start dev server on localhost:3000
npm run build      # Production build
npm run lint       # ESLint
npm run kpi:funnel # Funnel report against DynamoDB (or `<username>` for one user)
```

Scripts of note (under `front_end/scripts/`):

- `funnel-report.ts` — signup + onboarding funnel CLI.
- `tag-rfp-naics.ts` — Haiku NAICS tagger backfill (paired with
  `critique-rfp-tags.ts` + `apply-rfp-tag-critique.ts`).
- `embed-rfp-cache.ts` / `embed-rfp-cache-rebuild.ts` — Voyage embedder
  for `rfp_cache.embedding`.
- `backfill-task-due-dates.ts`, `backfill-task-template-additions.ts` —
  one-shots used while the tracker rolled out.
- `inspect-rds-migrations.ts` — diff Drizzle migrations against RDS.

**Environment Variables** (`front_end/.env.local`):

```
JWT_SECRET=...                  # Required. >=32 chars; placeholder values rejected.
DATABASE_URL=postgres://...     # Required. Postgres connection string.
ANTHROPIC_API_KEY=...           # NAICS tagger + critic, scraping enrichment, summaries
VOYAGE_API_KEY=...              # Embedding generation for rfp_cache and profile
GROQ_API_KEY=...                # Optional; legacy front-end extractor + scraping fallback
OPENAI_API_KEY=...              # Optional; provider-agnostic LLM layer
AWS_ACCESS_KEY_ID=...           # S3 + DynamoDB
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=civitas-ai
RESEND_API_KEY=...              # Transactional email
CIVITAS_FROM_EMAIL=...          # e.g. "Civitas <register@civitas-ai.net>"
CIVITAS_CRON_SECRET=...         # Bearer secret for /api/cron/* routes
CIVITAS_APP_ORIGIN=...          # e.g. https://civitas-ai.net (used in email links)
SKIP_EMAIL_VERIFICATION=true    # Dev / test cohort bypass
```
