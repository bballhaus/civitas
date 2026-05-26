# Frontend Architecture

Civitas's frontend is a **Next.js 16** application built with React 19, TypeScript, and Tailwind CSS 4. It handles RFP browsing, matching, profile management, AI document generation, and authentication.

## Tech Stack

| Technology | Purpose |
|---|---|
| Next.js 16.2 | React framework with server-side API routes |
| React 19.2 | UI component library |
| TypeScript 5 | Type-safe development |
| Tailwind CSS 4 | Utility-first styling |
| Provider-agnostic LLM (`lib/llm.ts`) | Server-side proposal, plan, and extraction calls; Groq / OpenAI / Anthropic |
| AWS SDK (S3 + DynamoDB) | Fetching scraped RFPs, raw uploads, KPI events |
| Drizzle ORM + Postgres | User, profile, contracts, claims, match state |
| Resend | Transactional email |
| mupdf | PDF text extraction |
| FullCalendar | Tracker calendar view |
| react-markdown | Rendering generated documents |

## Directory Structure

```
front_end/src/
├── app/                              # Next.js App Router pages & API routes
│   ├── page.tsx                      # Root redirect
│   ├── layout.tsx                    # Root layout (fonts, global CSS, prefetch)
│   ├── login/page.tsx                # Login form
│   ├── signup/page.tsx               # Registration with password validation
│   ├── forgot-password/, reset-password/  # Password reset flow
│   ├── home/page.tsx                 # Overview dashboard (stats, deadlines)
│   ├── upload/page.tsx               # Contract upload & AI extraction
│   ├── onboarding/page.tsx           # Guided onboarding wizard (v2)
│   ├── profile-setup/page.tsx        # First-time profile setup
│   ├── profile/page.tsx              # Full profile editor
│   ├── matches/page.tsx              # Match list (v2 scoring + filters)
│   ├── tracker/page.tsx              # Saved / applied / in-progress tracker + calendar
│   ├── contracts/page.tsx            # Contract portfolio + review claims
│   ├── dashboard/
│   │   ├── page.tsx                  # Main RFP search & matching interface
│   │   └── rfp/[id]/page.tsx         # Individual RFP detail view
│   └── api/                          # Server-side API routes
│       ├── auth/                     # JWT auth, signup, verify, forgot/reset password
│       ├── contracts/                # Contract CRUD + extraction + claims
│       ├── profile/                  # Profile CRUD + multi-doc extraction + refresh
│       ├── user/                     # RFP status, saved POE/proposals, feedback
│       ├── onboarding/               # Guided onboarding state machine
│       ├── match/                    # v2 match scoring + per-RFP detail
│       ├── tracker/                  # Tracker queries (key dates, applied/in-progress)
│       ├── events/route.ts           # Fetch & transform RFPs from S3 / rfp_cache
│       ├── cron/                     # Vercel-cron + Lambda-cron entry points (daily roundup, KPI aggregate)
│       ├── email/                    # SES bounce/complaint webhook
│       ├── admin/                    # KPI aggregation (Bearer-protected)
│       └── capabilities-analysis/, match-summary/, rfp-requirements-summary/, generate-proposal/, generate-plan-of-execution/
├── components/                       # AppHeader, MeshBackground, PrefetchEvents, LoadingScreen, MarkdownContent, FullCalendar wrappers, etc.
├── lib/
│   ├── api.ts                        # Frontend API client (auth, profile, contracts)
│   ├── auth.ts                       # JWT signing/verification, password hashing
│   ├── llm.ts                        # Provider-agnostic chatCompletion (Groq/OpenAI/Anthropic)
│   ├── config.ts                     # Typed access to civitas.config.json
│   ├── s3.ts, dynamodb.ts            # AWS clients (singleton, lazy-init)
│   ├── email.ts                      # Resend wrapper + dev console fallback
│   ├── email-index.ts                # S3-based email uniqueness index
│   ├── user-data.ts                  # Postgres user/profile CRUD + cache
│   ├── contract-storage.ts, contract-pipeline-v2.ts  # Upload + classify + claims
│   ├── profile-storage.ts            # Profile read/write/aggregate
│   ├── extraction.ts                 # Front-end LLM document extraction
│   ├── pii-redaction.ts              # Regex PII redaction before LLM calls
│   ├── claim-acceptance.ts           # Apply accepted claims to profile rows
│   ├── rfp-status.ts                 # RFP application tracking
│   ├── rate-limit.ts                 # Sliding-window rate limit utility
│   ├── rfp-matching.ts               # v1 matching algorithm (1300+ lines, still used as fallback)
│   ├── matching-v2.ts                # v2 source-aware matching algorithm
│   ├── match-rescore.ts, match-rescore-trigger.ts  # Background re-scoring
│   ├── embeddings.ts                 # Embedding generation (Voyage / OpenAI)
│   ├── naics-similarity.ts, profile-naics.ts        # NAICS substitution + matching
│   ├── rfp-cache-populator.ts        # Refresh rfp_cache rows from scraped manifests
│   ├── rfp-source-visibility.ts      # Hide gated sources (e.g. PlanetBids today)
│   ├── parse-deadline.ts             # Robust RFP deadline parsing
│   ├── kpi-aggregator.ts             # KPI rollup writer
│   ├── event-log.ts, event-tracker.ts # KPI emit (server / client)
│   ├── events.ts                     # KPI taxonomy (SERVER_EVENT_TYPES, CLIENT_EVENT_TYPES)
│   ├── capabilities.ts               # Capability normalization & synonyms
│   ├── events-cache.ts               # Server-side RFP read cache
│   ├── rfp-portal.ts                 # Portal-aware RFP helpers
│   ├── sns-verify.ts                 # SES bounce SNS signature verification
│   └── security-log.ts               # Structured JSON log for auth events
├── db/                               # Drizzle schema, client, migrations (see db/README.md)
├── proxy.ts                          # Edge proxy: rate limiting + nonce CSP
├── data/                             # filter-options.ts, california-counties.json, capabilities.json
└── types/                            # Type declarations
```

## Pages & User Flows

### Authentication

**Login** (`/login`) — Username/password form that authenticates via `/api/auth/login`. On success, the server sets a JWT in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie and the page redirects to `/home`.

**Signup** (`/signup`) — Registration form with real-time password strength validation:
- At least 8 characters
- One uppercase letter, one lowercase letter, one special character

On successful signup, the user enters the guided onboarding wizard at `/onboarding`.

### Onboarding

**Onboarding wizard** (`/onboarding`) — Multi-step guided interview (identity → specialties → capabilities → licenses → certifications → geography → scope & duration → capacity & history → finish). Each step persists immediately; the user can leave and resume. See [Architecture-v2 § 5](Architecture-v2.md).

**Upload / Contracts** (`/upload`, `/contracts`) — Drag-and-drop interface for uploading past contracts (PDF, DOCX, TXT). The backend extracts text (via `mupdf` / `mammoth`), runs PII redaction, calls the configured LLM (`lib/llm.ts`) to parse company metadata, and surfaces extracted claims for review before they touch the profile.

**Profile Setup** (`/profile-setup`) — First-time profile editor; pre-populated from document extraction results.

### Core Application

**Home** (`/home`) — Overview dashboard showing:
- Quick stats: saved RFPs, applied count, in-progress count, upcoming deadlines
- Card sections for saved, applied, and in-progress RFPs
- Upcoming deadline alerts (next 30 days)

**Matches** (`/matches`) — Main RFP matching interface (powered by `matching-v2.ts`):
- Reads pre-scored matches from `match_state` plus on-demand scoring for new RFPs
- Source-aware `data_quality` badges (full / requirements-only / market-intel / thin)
- Filter categories: industry, agency, value range, capabilities, contract type, certifications, clearances, NAICS codes, cities, counties, size status, deadline status
- Sort by match score, deadline, or value
- Incumbent chips when the state machine signals likely incumbent
- Save, apply, and in-progress status actions

**Dashboard** (`/dashboard`) — Legacy v1 matching interface, retained while v2 stabilizes. Scores RFPs against the user's profile entirely client-side via `rfp-matching.ts`.

**RFP Detail** (`/dashboard/rfp/[id]` and `/matches/...`) — Deep-dive into a single RFP:
- Full metadata display (description, contact info, requirements)
- Detailed match score breakdown with citations (RFP phrase + profile claim source)
- Prime track + sub-on-prime track (v2)
- AI-generated **Proposal** and **Plan of Execution**
- Iterative refinement with user feedback
- Optional style reference from past proposals

**Tracker** (`/tracker`) — Saved / applied / in-progress RFPs with a FullCalendar view of upcoming key dates (proposal due, pre-bid meeting, Q&A deadline, award).

**Profile** (`/profile`) — Full profile editor with sections for:
- Company name, industries, business size status, year founded, employee band
- Specialties (primary) vs. Capabilities (broader)
- Licenses (typed by class), certifications (hard vs. soft)
- Work locations (cities, counties, metro) with hard/soft flag
- Agency relationships (role, strength, recency)
- Scope/duration/complexity preferences, prime-vs-sub posture
- Provenance per field (which contract evidenced this claim)
- Uploaded contract documents

## API Routes (Server-Side)

These Next.js API routes run on the server and handle data fetching and AI generation.

### `GET /api/events`
Fetches scraped RFPs (from the Postgres `rfp_cache` and / or S3 manifests, depending on the read path) and transforms them into structured objects. Merges LLM-extracted attachment data (NAICS codes, certifications, deliverables) where the source supports it. Includes intelligent inference of industry, capabilities, and location from title/description text. Cached for `cache.s3TtlMs` (default 5 min).

### `GET /api/match`, `GET /api/match/{rfp_id}`
Returns v2 match results for the current user — score, win_probability, prime / sub track breakdowns, citations, and `data_quality` badge. See [Architecture-v2 § 9](Architecture-v2.md).

### `POST /api/onboarding/step/{n}`, `GET /api/onboarding/state`
Persist a single onboarding step / resume the wizard.

### `GET /api/tracker/...`
Tracker queries (key dates from RFP attachments, saved / applied / in-progress status).

### `POST /api/cron/daily-roundup`
Bearer-authed cron entry point hit hourly by the EventBridge → Lambda shim in `infra/notifications/`; sends the morning RFP digest to opted-in users in their local 7am.

### `POST /api/cron/sync-rfp-cache`
Refreshes the Postgres `rfp_cache` from the newest scraped manifests and re-embeds new RFPs.

### `POST /api/email/...` (SES bounce/complaint webhook)
Receives SNS notifications for messages sent during the legacy AWS SES era; new outbound mail goes through Resend.

### `POST /api/generate-proposal`
Generates an AI proposal draft via the configured LLM (`lib/llm.ts`). Accepts the RFP, company profile, and optional past proposals for style matching. Supports iterative refinement with user feedback.

### `POST /api/generate-plan-of-execution`
Generates an internal planning document via `lib/llm.ts` covering: requirements summary, capability gap analysis, action items, execution phases, and risks. Designed for internal decision-making rather than submission.

### `POST /api/match-summary`
Generates a natural-language summary explaining why an RFP matches (or doesn't match) the user's profile.

### `POST /api/rfp-requirements-summary`
Summarizes RFP requirements in a structured format for quick review.

### `POST /api/capabilities-analysis`
Analyzes the gap between a user's capabilities and an RFP's requirements.

## API Client (`lib/api.ts`)

Centralized module for all backend communication.

**Authentication**: `getAuthToken()`, `setAuthToken()`, `clearAuthToken()` (vestigial no-ops kept for backward-compat — the JWT now lives in an HttpOnly cookie and JS never touches it); `authHeaders()` returns headers for non-auth API calls.

**User Management**: `getCurrentUser()`, `getProfileFromBackend()`, `logout()`

**Profile**: `saveProfileToBackend()`, `uploadContractDocument()`, `deleteContractDocument()`, `listContracts()`

**RFP Status**: `updateUserRfpStatus()`, `getGeneratedPoe()`, `getGeneratedProposal()`

**Caching**: `getCachedUser()`, `setCachedUser()`, `getCachedProfile()`, `setCachedProfile()`

The client auto-detects the environment (dev vs. prod) and routes requests to the appropriate backend URL.

## State Management & Caching

- **Auth cookie**: HttpOnly/Secure/SameSite=Strict JWT, set server-side (never written from JS)
- **localStorage**: cached profile snapshot, saved RFP IDs, UI preferences only (never the auth token)
- **In-memory cache**: User object and profile cached per session
- **Server-side S3 cache**: scraped RFP events cached for `cache.s3TtlMs` (default 5 min) with stale-while-revalidate
- **Postgres `rfp_cache`**: denormalized read view of scraped manifests, refreshed on read
- **PrefetchEvents component**: Preloads RFP data in the background on app mount
- **React useDeferredValue**: Smooth filter updates on the dashboard without blocking UI

## Development

```bash
cd front_end
npm install
npm run dev     # Start dev server on localhost:3000
npm run build   # Production build
npm run lint    # ESLint
```

**Environment Variables** (`front_end/.env.local`):
```
JWT_SECRET=...                  # Required. Strong random value for JWT signing.
DATABASE_URL=postgres://...     # Required. Postgres connection string.
GROQ_API_KEY=...                # LLM provider keys; set whichever match civitas.config.json
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
AWS_ACCESS_KEY_ID=...           # For S3 + DynamoDB
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=civitas-ai
RESEND_API_KEY=...              # Transactional email
CIVITAS_FROM_EMAIL=...          # e.g. "Civitas <register@civitas-ai.net>"
```
