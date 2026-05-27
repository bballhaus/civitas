# Key Features

Walkthrough of each live product feature, from user interaction down
to backend persistence. For retired components (proposal / POE
generation, legacy dashboard, v1 profile editor, v1 matcher), see
[Retired Features](Retired-Features).

---

## 1. RFP Discovery & Matching (`/matches`)

### What it does

Users land on a list of California government RFPs scraped from 60+
procurement portals, each scored 0-100 against their onboarded
profile. Filter chips, sort, prime / sub eligibility, incumbent
chips, and `data_quality` badges keep the noisy long-tail
interpretable.

### How it works

**Data pipeline** (full detail in
[`webscraping/v2/README.md`](../webscraping/v2/README.md) and
[`webscraping/v2/COVERAGE.md`](../webscraping/v2/COVERAGE.md)):

1. AWS Lambda fires every 48 hours
   ([`webscraping/v2/deploy/template.yaml`](../webscraping/v2/deploy/template.yaml)).
   Source scrapers under `webscraping/v2/scrapers/` hit each portal,
   write per-source manifests to `s3://civitas-ai/scrapes/v2/{source}/`,
   and (for Cal eProcure + OpenGov) download attachments inline.
2. PDF text is extracted via PyMuPDF and enriched by Claude Haiku 4.5
   (`webscraping/v2/pipeline/enrich.py`) into structured requirements:
   NAICS, certifications, licenses, clearances, deliverables,
   evaluation criteria, incumbent vendor, key dates (Q&A,
   pre-bid, site visit, award, contract start / end).
3. The scraping Lambda calls
   [`/api/cron/sync-rfp-cache`](../front_end/src/app/api/cron/sync-rfp-cache/route.ts),
   which populates `rfp_cache`, runs the Haiku-based NAICS tagger
   (`lib/rfp-tagger.ts`) for `primary_naics` + up to 4
   `secondary_naics` + a one-sentence `scope_summary`, and refreshes
   Voyage-3-large embeddings on changed rows.
4. A separate daily cron
   ([`/api/cron/critique-rfp-tags`](../front_end/src/app/api/cron/critique-rfp-tags/route.ts))
   runs a Sonnet 4.6 audit (`lib/rfp-tag-critic.ts`) over rows where
   `naics_critiqued_at IS NULL`, corrects systematic Haiku failure
   modes (tagging the agency instead of the work, etc.), and re-embeds
   anything Sonnet changed.

**Match scoring** (`lib/matching-v2.ts` — full spec in
[Matching-Algorithm-v2](Matching-Algorithm-v2)):

- Hard gates fire only on non-empty RFP data — `licenses_required: []`
  on a PlanetBids RFP means "we don't know," not "no license needed."
- Range matches on scope, duration, complexity.
- Semantic match on specialty + capability embeddings via pgvector,
  confidence-weighted by source data quality.
- Relationship signals (agency, soft certs, vendor history).
- Incumbent state machine (`likely` / `open_field` / `unknown`)
  adjusts win probability separately from score.
- Sub-on-prime track runs in parallel — failing a prime gate routes
  the RFP to sub eligibility rather than disqualifying.
- Every category emits a citation: the RFP phrase + the profile claim
  that justified it.

**Serving to the frontend:**

- `/api/match` (list) and `/api/match/[rfpId]` (detail) read
  pre-scored matches from `match_state.cached_*`. Missing entries
  trigger an on-demand score plus a background populate via
  `lib/match-rescore-trigger.ts`.
- Profile changes, RFP edits, and NAICS critique runs invalidate the
  cache; `lib/match-rescore.ts` is the sole writer.
- `/matches/[rfpId]` fires `POST /api/rfp-views` on mount so the daily
  roundup can skip already-viewed RFPs.

---

## 2. Onboarding Wizard (`/onboarding`)

### What it does

A 9-step guided interview that captures the matching-critical fields
directly from the user, instead of relying on document extraction. Each
step persists immediately; the user can leave and resume.

### How it works

1. Identity (company, year founded, employee band, website)
2. Specialties — primary, 2-3 picks, embedded via Voyage
3. Capabilities — broader picks; also embedded
4. NAICS codes — searchable, multi-select
5. Licenses — typed by class (CSLB A / B / C-XX, PE, DIR, ...)
6. Certifications — hard vs soft, two columns
7. Geography — cities / counties / metros with a hard flag
8. Scope & duration — `scope_min_usd`, `scope_max_usd`, duration
   preference, complexity preference
9. Capacity & history — prime-vs-sub posture, gov experience tiers,
   agency relationship seeds

Each step's data goes through a `CommitProvider` that batches PATCH
writes to the per-entity endpoints under `/api/profile/`. On Finish,
`POST /api/onboarding/state/` sets `profiles.onboarded_at` and the
user is redirected to `/upload` (or `/profile/v2` in edit mode).

Onboarding step UI lives in `app/onboarding/Steps.tsx` and is reused
verbatim inside `/profile/v2`'s `EditableSection`s, so the wizard and
the profile editor stay in lock-step.

---

## 3. Contract Claim Review (`/contracts`, `/contracts/[id]/review`)

### What it does

Users upload past proposals, executed contracts, capability statements,
and license certificates. The system classifies each document, extracts
typed facts ("claims") with snippets and confidence, and surfaces them
for accept / edit / reject before any profile row changes.

### How it works

1. **Upload** to `/api/contracts/v2/` — file is validated (size, type,
   magic bytes), saved to `s3://civitas-ai/uploads/{user_id}/{contract_id}/`,
   text extracted via mupdf / mammoth, PII-redacted, then
   classified with Claude Haiku 4.5
   (`lib/contract-pipeline-v2.ts`).
2. **Classifier** outputs `document_type`: `proposal` /
   `executed_contract` / `capability_statement` / `license_doc` /
   `rfp_solicitation` / `other`, plus a `contract_status` for
   proposals / executed contracts. The `rfp_solicitation` category is
   a guardrail — if the user accidentally uploads the agency's RFP
   instead of their own work, the UI redirects rather than extracting
   "RFP requires Class A license" *as if the user holds Class A*.
3. **Targeted extractor** (Sonnet 4.6) runs the per-`document_type`
   prompt; output is an array of claims with `field_path`, `value`,
   `snippet`, and a `confidence` that's multiplied by a source-type
   weight (executed contract = 1.0, proposal won = 0.9, proposal lost
   = 0.7, capability statement = 0.75, etc.).
4. **Review** at `/contracts/[id]/review` — grouped by `field_path`,
   each claim shows its snippet, confidence, and source-type label.
   Accept / Edit / Reject per claim; bulk "accept all from this
   document." Accept writes through `lib/claim-acceptance.ts` to the
   corresponding profile table.

A claim that's accepted, then later edited in the profile UI, retains
the snippet provenance so `/api/profile/provenance` can answer
"why does my profile say X."

---

## 4. Bidding Tracker (`/tracker`, `/home`)

### What it does

Once a user saves an RFP, it enters their bidding pipeline. They
move it through six states — `saved` → `in_progress` → `bid_submitted`
→ `won` / `lost` / `no_bid` — and check off a default 7-item task
list (review attachments, confirm bid/no-bid, submit Q&A, attend
pre-bid, draft, internal review, submit bid). Custom tasks can be
added inline.

### How it works

- **Pipeline state** lives in `match_state.status` with a
  `status_changed_at` audit column. Transitions go through
  `PATCH /api/user/rfp-status/`; the same route also writes
  match-feedback (`good` / `bad` + reason).
- **Default tasks** are seeded on first save by
  `POST /api/user/rfp-status/` from a template; further task CRUD
  goes through `/api/tasks/` and `/api/tasks/[id]/`.
- **Calendar** uses FullCalendar (`/tracker`) and a hand-rolled mini
  calendar (`/home`). RFP deadlines + extracted key dates
  (`qa_deadline`, `prebid_meeting_at`, `site_visit_at`, etc.) and
  custom task due dates are merged into one stream.
- **Home dashboard** shows pipeline counts per bucket plus a "Due in
  30 days" tile and the upcoming-deadlines list. Quick stats come
  from `GET /api/tracker`.

---

## 5. RFP Detail (`/matches/[rfpId]`)

### What it does

The full match deep-dive. Prime + Sub track tabs, per-category citation,
LLM-generated context summaries, attachments, key dates, action panel.

### How it works

The page loads `/api/match/[rfpId]` once on mount, which returns the
full v2 `DetailResponse` (RFP metadata, score, win probability,
tier, prime / sub eligibility, gate failures, incumbent state,
`data_quality`, breakdown rows with citations, sub-track breakdown).

Three LLM summaries are computed on demand and lazy-loaded:

- **Match summary** (`/api/match-summary/`) — natural language "why is
  this a good / bad fit?"
- **RFP requirements summary** (`/api/rfp-requirements-summary/`) —
  structured "what does this RFP ask for?"
- **Capabilities analysis** (`/api/capabilities-analysis/`) — gap
  analysis between profile capabilities and RFP requirements.

Save / unsave + pipeline status update inline. Good / bad match
feedback writes to `match_state.feedback_*` with a snapshot of the
score the user saw (so feedback remains explainable after the live
score changes).

Attachments are proxied through `/api/attachments/[...key]` (signed
S3 URL with auth check); the page also fires fine-grained KPI events
(`rfp_section_expanded`, `rfp_attachment_clicked`,
`rfp_external_link_clicked`, `rfp_dwell`).

---

## 6. Daily Roundup Email

### What it does

Once-a-day morning digest of new, high-fit, unviewed RFPs, sent at each
user's local 7am to anyone who opts in during onboarding.

### How it works

1. EventBridge fires
   [`infra/notifications/lambda.mjs`](../infra/notifications/lambda.mjs)
   every hour.
2. The Lambda POSTs `/api/cron/daily-roundup/` with the cron Bearer
   secret.
3. The route reads `profiles WHERE daily_roundup_enabled = true`,
   filters to users whose local hour is 7 (via
   `daily_roundup_timezone`), runs `matching-v2.ts` against the
   currently-open RFP catalog, filters out anything with a non-null
   `match_state.viewed_at`, keeps matches scoring ≥75, and sends
   the digest via Resend
   ([`lib/email.ts`](../front_end/src/lib/email.ts) →
   `sendDailyRoundupEmail`).

The Lambda is intentionally trivial so business logic stays in
Next.js (DB schema, matcher, Resend wiring) without being duplicated.

---

## 7. Authentication & Session

### What it does

JWT-based auth with HttpOnly cookies. Production signup requires email
verification; a `SKIP_EMAIL_VERIFICATION` flag bypasses for the test
cohort.

### How it works

- **Login** (`/api/auth/login/`): bcrypt-verify, set
  `HttpOnly` / `Secure` / `SameSite=Strict` JWT cookie (7-day expiry).
- **Signup** (`/api/auth/signup/`): write `pending_users`, send Resend
  verification email. Click-through promotes the row into `users`
  inside a transaction and sets the cookie.
- **Password rules**: 8+ chars, one upper / one lower / one special.
  Bcrypt (12 rounds). Django PBKDF2 hashes transparently re-hashed on
  login.
- **Password reset**: `/api/auth/forgot-password/` →
  `users.password_reset_token` + 1-hour expiry → reset link →
  `/api/auth/reset-password/`.
- **Data isolation**: every server route calls
  `getAuthenticatedUser(request)` from `lib/auth.ts` before any DB or
  S3 read; queries always join through `users(id)`.

See [Security & Optimization](Security) for the full security control
matrix.

---

## 8. Admin KPI Dashboard (`/admin/kpis`)

### What it does

Internal-only dashboard for measuring product usage. Allowlist-gated.
Shows total / DAU / WAU / MAU, signup funnel rollups, per-event
counters, time-series charts, and raw event drill-down.

### How it works

- `lib/event-log.ts` writes every server event to
  `civitas-kpi-events` (DynamoDB), updating per-user counters and
  funnel checkpoints in `civitas-kpi-users`.
- `lib/event-tracker.ts` plus `/api/events/track/` are the client-side
  equivalent (allowlisted `CLIENT_EVENT_TYPES` only).
- `lib/kpi-aggregator.ts` runs nightly via
  `/api/admin/aggregate-kpis/` (cron-secret-protected) and writes
  `metrics/aggregate/latest.json` plus
  `metrics/aggregate/daily/{YYYY-MM-DD}.json` to S3.
- `/admin/kpis` reads the snapshot via `/api/admin/kpis/`, time-series
  via `/api/admin/kpis/timeseries/?granularity=day|week|month`, and
  raw events via `/api/admin/events/?type=...` (DynamoDB
  `byEventType` GSI).

A CLI alternative — `npm run kpi:funnel [username]` — runs against
DynamoDB directly. See [KPIs](KPIs) for the event taxonomy and the
report format.
