# Civitas Architecture v2 — Detailed Spec

Companion to [Matching-Values.md](Matching-Values.md) and [webscraping/v2/COVERAGE.md](../webscraping/v2/COVERAGE.md).

> **Status (2026-05-27): largely shipped.** The Postgres schema (§ 4),
> onboarding flow (§ 5), claims-based evidence pipeline (§ 6), PII
> redaction (§ 7), Voyage-3-large embeddings (§ 8), v2 matching
> algorithm (§ 9), source-routed incumbent state machine (§ 10), and
> v2 API surface (§ 11) are all live in production. The v2 UI surfaces
> in § 12 (onboarding, `/profile/v2`, `/matches`, `/matches/[rfpId]`,
> tracker) are live; the legacy `/dashboard` view is retired (see
> [Retired Features](Retired-Features)).
>
> Schema since this spec was first written has gained: a `pending_users`
> table for email-verify-before-create, an `rfp_tasks` table for the
> bidding tracker, a `cached_*` live-match cache on `match_state` plus
> `viewed_at` / `status_changed_at`, key-date columns on `rfp_cache`
> (`qa_deadline`, `prebid_meeting_at`, `site_visit_at`, `award_date`,
> `contract_start`, `contract_end`, `key_dates_sources`), a
> `scope_summary` column for Haiku tagger output, and
> `naics_critiqued_at` for the daily Sonnet critic pass. The pipeline
> status enum widened to six values: `'saved' | 'in_progress' |
> 'bid_submitted' | 'won' | 'lost' | 'no_bid'`.
>
> Items still open: vendor fingerprint dedup post-process,
> `match_impressions` / `match_outcomes` logging (see
> [Matching-Finetuning](Matching-Finetuning)), PlanetBids document
> unblock per agency, agentic Lambda fixes for LA / SF, and Cloudflare
> bypass for OpenGov.

---

## 1. Principles

1. **Profile is the source of truth.** Documents are evidence supporting profile claims, not the source of profile data. User edits never get overwritten by re-extraction.
2. **Onboarding-first, evidence-second.** Every user fills the matching-critical fields directly via a guided interview. Documents backfill provenance and add detail.
3. **Every claim has provenance.** Every extracted fact stores a snippet, a confidence score, and a doc reference. The profile UI can show "Cloud Services — only evidenced by contract X. Remove?"
4. **Hard signals are typed, soft signals are scored.** License class is binary, not partial credit. Set-aside lockouts disqualify. Specialty matching is semantic.
5. **Match results carry citations.** Each scoring category cites the source phrase from the RFP and the source profile claim. Addresses the "why is this a fit" gap from the discovery interviews.
6. **Two output tracks per RFP**: `prime_match` and `sub_match`. Prime gate failure routes to sub track instead of disqualifying.
7. **Empty fields are unknown, not zero.** A missing requirement on an RFP means the source doesn't expose that data — not that the requirement is absent. The matcher must distinguish "we know this is open" from "we don't know."

---

## 2. Source heterogeneity (read this first)

The authoritative coverage spec is [webscraping/v2/COVERAGE.md](../webscraping/v2/COVERAGE.md). This section summarizes the implications for matching.

RFPs from different sources have radically different completeness, and matching must account for that.

| Source | Sites | PDF requirements | Description | Market intel | Incumbent signal |
|---|---|:-:|:-:|:-:|:-:|
| **Cal eProcure** | 1 (state, ~642 events) | ✓ rich (LLM-extracted) | ✓ full + PDF rollup | ✗ source has no tabs | ✓ `incumbent_vendor` LLM-extracted (live) |
| **PlanetBids** | 42 portals | ✗ gated behind per-agency vendor login | ✓ from detail page | ✓ rich (`prospective_bidders`, `bid_results`, `award`) | ✓ from `award` history |
| **BidSync / Periscope** | 15 agencies | ✗ login required | ✗ login required | ✗ none | ✗ none |
| **Agentic** (LA City, SF City) | 2 | n/a | n/a | n/a | currently broken on Lambda |

### Consequences for the matcher

1. **Hard gates fire only on non-empty data.** A PlanetBids RFP with `licenses_required: []` does not mean the RFP has no license requirement — the PDFs are gated. Empty must be treated as unknown.
2. **Incumbent signal is source-routed, not unified.** Different sources surface incumbency through different fields. See § 10 for the state machine.
3. **Embedding quality varies by source.** BidSync gives us only the title; Cal eProcure gives title + description + attachment text. Semantic-only matches on thin sources should carry lower confidence.
4. **Match output must include `data_quality`.** UI surfaces "limited data" vs. "full requirements available" so users know how to weight the score.
5. **License-class hard gate is currently a Cal-eProcure-only mechanism.** Until PlanetBids documents are unblocked, license requirements on PlanetBids events are unknown — bonus signals at best, never disqualifiers.

### Active blockers tracked in COVERAGE.md

- PlanetBids document gating (per-agency vendor registration, legal/ops decision)
- BidSync detail-page login (vendor account or skip in favor of agency-direct sources)
- Agentic LA + SF on Lambda (Chromium / ENOSPC issues)
- Vendor fingerprint dedup post-process (planned, not yet running)

---

## 3. Storage architecture

**Postgres on RDS with `pgvector` extension.** Replaces the current S3-as-database pattern.

- Profile, contracts, claims, match state → Postgres
- Raw uploaded files → S3 (unchanged: `uploads/{user_id}/{contract_id}/...`)
- Scraped RFPs → still S3 manifests (no change to webscraping pipeline); new `rfp_cache` table is a denormalized read cache for matching, refreshed from manifests
- Vendor index (cross-event dedup) → S3 manifest at `scrapes/v2/vendors/index.json` (produced by webscraping post-process), mirrored into `vendors` table for join queries

**Why Postgres over DynamoDB**: relational shape (profile → contracts → claims, RFP → bidders), pgvector for embeddings in the same DB, full-text search for RFP descriptions, ACID for atomic claim acceptance, cleaner schema migrations, ~$15/mo on `db.t4g.micro`.

---

## 4. Postgres schema

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------
-- Users & auth
-- ---------------------------------------------------------------

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        TEXT UNIQUE NOT NULL,
    email           TEXT UNIQUE NOT NULL,
    email_verified  BOOLEAN NOT NULL DEFAULT false,
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Profile (1:1 with users)
-- ---------------------------------------------------------------

CREATE TABLE profiles (
    user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    company_name         TEXT,
    year_founded         INT,
    employee_band        TEXT,    -- '1' | '2-10' | '11-50' | '51-200' | '201-1000' | '1000+'
    website              TEXT,
    -- preferences
    scope_min_usd        BIGINT,
    scope_max_usd        BIGINT,
    duration_pref        TEXT,    -- 'short' | 'any' | 'retention_ok'
    complexity_pref      TEXT,    -- 'simple_only' | 'any' | 'any_with_subs'
    prime_vs_sub         TEXT,    -- 'prime_only' | 'open_to_sub' | 'sub_only'
    gov_experience       TEXT,    -- 'none' | 'local' | 'state' | 'federal'
    -- vendor identity (links to PlanetBids vendor data)
    vendor_fingerprint   TEXT,    -- matches webscraping vendors index
    vendor_resolved_at   TIMESTAMPTZ,
    -- meta
    completeness_score   REAL DEFAULT 0,
    onboarded_at         TIMESTAMPTZ,
    embedding_updated_at TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_vendor_fingerprint ON profiles(vendor_fingerprint);

-- ---------------------------------------------------------------
-- Specialties (the bread and butter — primary match dimension)
-- ---------------------------------------------------------------

CREATE TABLE specialties (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value        TEXT NOT NULL,
    canonical_id TEXT,                    -- mapped to capability taxonomy if found
    weight       TEXT NOT NULL DEFAULT 'primary',  -- 'primary' | 'secondary'
    embedding    vector(1024),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, value)
);

CREATE INDEX idx_specialties_user      ON specialties(user_id);
CREATE INDEX idx_specialties_embedding ON specialties USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------
-- Capabilities (broader than specialties — what they CAN do)
-- ---------------------------------------------------------------

CREATE TABLE capabilities (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value        TEXT NOT NULL,
    canonical_id TEXT,
    embedding    vector(1024),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, value)
);

CREATE INDEX idx_capabilities_user      ON capabilities(user_id);
CREATE INDEX idx_capabilities_embedding ON capabilities USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------
-- Licenses (typed, NOT free-text — this is what enables binary matching)
-- ---------------------------------------------------------------

CREATE TABLE licenses (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    license_class  TEXT NOT NULL,    -- 'A', 'B', 'C-12', 'C-36', 'PE', 'DIR', 'PEST_CONTROL', etc.
    license_number TEXT,
    expires_on     DATE,
    verified       BOOLEAN NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_licenses_user ON licenses(user_id);

-- ---------------------------------------------------------------
-- Certifications (hard vs soft is now a column, not separate maps)
-- ---------------------------------------------------------------

CREATE TABLE certifications (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    canonical_id TEXT NOT NULL,           -- 'dvbe' | 'fedramp' | 'iso_9001' | ...
    display_name TEXT NOT NULL,
    kind         TEXT NOT NULL,           -- 'hard' | 'soft'
    expires_on   DATE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, canonical_id)
);

CREATE INDEX idx_certifications_user_kind ON certifications(user_id, kind);

-- ---------------------------------------------------------------
-- Work areas (with hard flag)
-- ---------------------------------------------------------------

CREATE TABLE work_areas (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,    -- 'city' | 'county' | 'metro' | 'state'
    name       TEXT NOT NULL,
    is_hard    BOOLEAN NOT NULL DEFAULT false,  -- "won't travel outside this"
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, kind, name)
);

CREATE INDEX idx_work_areas_user ON work_areas(user_id);

-- ---------------------------------------------------------------
-- Agency relationships (strength + role + recency)
-- Auto-populated from vendor fingerprint when available; manually editable.
-- ---------------------------------------------------------------

CREATE TABLE agency_relationships (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agency_canonical  TEXT NOT NULL,    -- normalized: 'caltrans', 'dgs', 'lausd'
    agency_display    TEXT NOT NULL,
    role              TEXT NOT NULL,    -- 'prime' | 'sub'
    contract_count    INT NOT NULL DEFAULT 1,
    last_contract_at  DATE,
    strength          SMALLINT NOT NULL DEFAULT 1,  -- 1-5
    source            TEXT NOT NULL DEFAULT 'user', -- 'user' | 'vendor_fingerprint' | 'extraction'
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, agency_canonical, role)
);

CREATE INDEX idx_agency_relationships_user ON agency_relationships(user_id);

-- ---------------------------------------------------------------
-- Contracts (uploaded documents — evidence, not authority)
-- ---------------------------------------------------------------

CREATE TABLE contracts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type       TEXT NOT NULL,    -- see § 6.1
    s3_key              TEXT NOT NULL,
    original_filename   TEXT NOT NULL,
    title               TEXT,
    -- extracted basics (optional; specific to document_type)
    issuing_agency      TEXT,
    contract_value_usd  BIGINT,
    duration_text       TEXT,
    role                TEXT,             -- 'prime' | 'sub'
    award_date          DATE,
    start_date          DATE,
    end_date            DATE,
    -- diagnostic
    raw_extraction      JSONB,
    extracted_by_model  TEXT,
    extracted_at        TIMESTAMPTZ,
    extracted_text      TEXT,
    text_truncated      BOOLEAN NOT NULL DEFAULT false,
    -- redaction log
    pii_redacted_count  INT DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contracts_user ON contracts(user_id);

-- ---------------------------------------------------------------
-- Claims (every fact extracted, with provenance and review status)
-- ---------------------------------------------------------------

CREATE TABLE claims (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contract_id UUID REFERENCES contracts(id) ON DELETE CASCADE,
    field_path  TEXT NOT NULL,     -- 'specialties.value' | 'licenses.class' | ...
    value       TEXT NOT NULL,
    snippet     TEXT,              -- text from the doc that justifies this claim
    confidence  REAL,              -- 0-1 from the extractor
    status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'rejected'
    decided_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_claims_user_status ON claims(user_id, status);
CREATE INDEX idx_claims_contract    ON claims(contract_id);

-- ---------------------------------------------------------------
-- Match state per (user, RFP)
-- ---------------------------------------------------------------

CREATE TABLE match_state (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rfp_id              TEXT NOT NULL,
    status              TEXT,             -- 'saved' | 'applied' | 'in_progress'
    match_score         REAL,
    match_tier          TEXT,
    win_probability     REAL,
    incumbent_state     TEXT,             -- 'likely' | 'open_field' | 'unknown'
    feedback_rating     TEXT,             -- 'good' | 'bad'
    feedback_reason     TEXT,
    feedback_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, rfp_id)
);

CREATE INDEX idx_match_state_user_status ON match_state(user_id, status);

-- ---------------------------------------------------------------
-- Generated documents (POE, proposals)
-- ---------------------------------------------------------------

CREATE TABLE generated_documents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rfp_id       TEXT NOT NULL,
    kind         TEXT NOT NULL,    -- 'plan_of_execution' | 'proposal'
    content      TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_generated_user_rfp ON generated_documents(user_id, rfp_id);

-- ---------------------------------------------------------------
-- RFP cache (denormalized read view of v2 manifests for matching)
-- All fields are nullable / empty-able. Empty = unknown, not zero.
-- ---------------------------------------------------------------

CREATE TABLE rfp_cache (
    id                       TEXT PRIMARY KEY,
    source_id                TEXT NOT NULL,         -- 'caleprocure' | 'planetbids_san_diego' | ...
    title                    TEXT NOT NULL,
    description              TEXT,
    agency                   TEXT,
    location                 TEXT,
    deadline                 TIMESTAMPTZ,
    estimated_value_usd      BIGINT,

    -- LLM-extracted (Cal eProcure today; PlanetBids/BidSync empty)
    capabilities             TEXT[],
    naics_codes              TEXT[],
    certifications_required  TEXT[],   -- programs/status certs (DBE, MBE, DIR)
    licenses_required        TEXT[],   -- trade licenses (CSLB Class A, C-10, PE) — separated per webscraping schema
    set_aside_lockout        TEXT[],
    deliverables             TEXT[],
    requires_past_gov_exp    BOOLEAN,
    incumbent_vendor         TEXT,     -- LLM-extracted from RFP text (Cal eProcure live)
    incumbent_contract_end   DATE,

    -- Market intel (PlanetBids today; Cal eProcure/BidSync empty)
    prospective_bidder_count INT,
    bid_count                INT,
    bid_amounts_cents        BIGINT[], -- distribution; useful for pricing fit
    winning_bid_cents        BIGINT,
    winning_vendor_fingerprint TEXT,

    -- Semantic embedding
    embedding                vector(1024),

    -- Raw payload from manifest
    raw                      JSONB,
    refreshed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rfp_cache_embedding         ON rfp_cache USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_rfp_cache_deadline          ON rfp_cache(deadline);
CREATE INDEX idx_rfp_cache_agency            ON rfp_cache(agency);
CREATE INDEX idx_rfp_cache_source            ON rfp_cache(source_id);
CREATE INDEX idx_rfp_cache_winning_vendor    ON rfp_cache(winning_vendor_fingerprint);

-- ---------------------------------------------------------------
-- RFP bidders (normalized fan-out of prospective_bidders + bid_results)
-- Used for: vendor history queries, agency_relationships auto-populate,
-- "you've competed against" signals.
-- ---------------------------------------------------------------

CREATE TABLE rfp_bidders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rfp_id              TEXT NOT NULL REFERENCES rfp_cache(id) ON DELETE CASCADE,
    vendor_fingerprint  TEXT,           -- nullable until vendor index resolves
    vendor_name         TEXT NOT NULL,  -- always present; fingerprint is post-hoc
    role                TEXT NOT NULL,  -- 'prospective' | 'bidder' | 'winner'
    bid_amount_cents    BIGINT,
    responsive          BOOLEAN,
    classification      TEXT,           -- PlanetBids: 'Bidder' | 'Subcontractor' | 'Plan Room'
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rfp_bidders_rfp        ON rfp_bidders(rfp_id);
CREATE INDEX idx_rfp_bidders_fingerprint ON rfp_bidders(vendor_fingerprint);
CREATE INDEX idx_rfp_bidders_name        ON rfp_bidders USING gin (vendor_name gin_trgm_ops);

-- ---------------------------------------------------------------
-- Vendors (mirrors webscraping vendor index for join queries)
-- ---------------------------------------------------------------

CREATE TABLE vendors (
    fingerprint    TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    state          TEXT,
    city           TEXT,
    certifications TEXT[],
    first_seen_at  TIMESTAMPTZ,
    last_seen_at   TIMESTAMPTZ,
    bid_count      INT DEFAULT 0,
    win_count      INT DEFAULT 0,
    refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vendors_name ON vendors USING gin (name gin_trgm_ops);
```

---

## 5. Onboarding flow

Nine screens, ~7 minutes total. Each step persists immediately; user can leave and return. Skip enabled on every step except identity.

| # | Screen | Writes to |
|---|---|---|
| 1 | Identity | `profiles.{company_name, year_founded, employee_band, website}` |
| 2 | Specialties (primary) | `specialties` (weight=primary) — 2–3 picks |
| 3 | Capabilities (broader) | `capabilities` — multi-select |
| 4 | Licenses | `licenses` — typed by class |
| 5 | Certifications (hard + soft, two columns) | `certifications` |
| 6 | Geography | `work_areas` with hard flag |
| 7 | Scope & duration | `profiles.{scope_min_usd, scope_max_usd, duration_pref, complexity_pref}` |
| 8 | Capacity & history | `profiles.{prime_vs_sub, gov_experience}` + `agency_relationships` seeds |
| 9 | Done | `profiles.onboarded_at` |

After onboarding, `embedding_updated_at` triggers a background job to embed all specialties + capabilities (Voyage-3-large, 1024 dim).

`completeness_score` is recomputed on every profile change: % of weighted fields populated.

**Optional vendor identity resolution**: after onboarding, if the user's company name fuzzy-matches an entry in `vendors`, prompt them to claim that fingerprint. Confirms unlocks auto-population of `agency_relationships` from past bid history.

---

## 6. Evidence flow (LLM extraction)

### 6.1 Document types and contract status

Two orthogonal axes — `document_type` describes what the document IS, `contract_status` describes the win-state of the contract it relates to (when applicable).

```
document_type:
  proposal              # contractor's pitch document
  executed_contract     # signed agreement after award
  capability_statement  # marketing brochure / company profile / about-us material
  license_doc           # license certificate, registration, or credential
  rfp_solicitation      # the AGENCY's RFP itself; not contractor evidence (guardrail)
  other                 # fallback; user is asked to confirm

contract_status (relevant only for `proposal` and `executed_contract`):
  won | lost | in_progress | unknown
```

Splitting status from type lets us treat an executed contract as "won implicitly" while letting proposals carry explicit status. This replaces the old `won_contract` / `lost_bid` / `rfp_response_draft` triad.

The `rfp_solicitation` type is a guardrail. It catches the silent-failure mode where a user accidentally uploads an agency's RFP (the document the agency wrote requesting work) instead of the contractor's own proposal. Without this category, the LLM would extract the RFP's requirements *as if they applied to the user* — "RFP requires Class A license" silently becomes a claim that the user holds Class A. The doc isn't extracted; the UI redirects.

### 6.2 Two-stage extraction

```
upload → text extract (mupdf) → PII redact → classify
   ├── rfp_solicitation → redirect to proposal-generation flow (no extraction)
   └── everything else → extract per type → claims → review screen → accept/reject
```

### 6.3 Stage 1: Classifier

**Model**: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`), temperature 0.

**Prompt** (cached system message):

```
You classify procurement documents uploaded by a contractor about their own
company. Given the first ~3000 characters, return document_type, contract_status
(when applicable), and confidence.

document_type values:
- proposal:             a pitch the contractor wrote in response to an RFP
- executed_contract:    a signed/awarded agreement (post-award document)
- capability_statement: marketing material describing what the company does
                        (brochures, "about us" docs, company profiles, capability
                        statements)
- license_doc:          a license certificate, registration, or credential
- rfp_solicitation:     the AGENCY's RFP itself, not the contractor's response
- other:                anything else (resumes, financial statements, etc.)

How to distinguish proposal vs. rfp_solicitation:
  RFP markers (point of view = agency requesting work):
    "vendor shall", "the contractor must", "minimum qualifications",
    "submission requirements", "evaluation criteria", "scope of work"
    written in third person about a hypothetical bidder
  Proposal markers (point of view = contractor pitching):
    "we propose", "our team", "our approach", "we offer",
    written in first person from the contractor's side

contract_status (only for proposal or executed_contract):
- won:          contract was awarded to the contractor (look for award letter,
                signed agreement, references to performance)
- lost:         submitted but not awarded
- in_progress:  draft, not yet submitted, or awaiting decision
- unknown:      can't tell from the document
For executed_contract, contract_status is always "won".

Return JSON only:
{
  "document_type": "<type>",
  "contract_status": "<status or null>",
  "confidence": <0-1>,
  "reasoning": "<one sentence>"
}
```

If `confidence < 0.7`, surface the classification to the user before extraction so they can correct it.

### 6.4 Stage 2: Targeted extractors

**Model**: Claude Sonnet 4.6 (`claude-sonnet-4-6`), temperature 0.1, prompt caching on the system message.

Each extractor outputs a **claims array**. Every fact gets its own row with snippet + confidence.

#### `rfp_solicitation` — no extraction (guardrail)

Skip extraction. UI shows:

> *"This looks like an RFP solicitation, not a document about your company.*
> - *Use it to generate a proposal draft (proposal-generation flow)*
> - *I uploaded the wrong file (discard)"*

#### `proposal` — single extractor parameterized by `contract_status`

Extract: `contractor_name`, `role` (prime/sub), `agency`, `contract_value`, `duration`, `start_date`, `end_date`, `license_classes`, `certifications_held`, `specialties` (1–3 from the scope), `capabilities` (broader from scope), `naics_codes`, `work_locations`, `scope_summary`.

Status-specific behavior:
- `won`: full extraction; `agency_relationships.role` claim is `'prime'` or `'sub'` from the doc
- `lost`: same fields, but `agency_relationships.role` is tagged `'sub_or_interest'` (pursued but didn't win); skip contract_value claim (the bid amount is aspirational, not delivered)
- `in_progress`: same as `won` shape; mark `contract_status='in_progress'` in claim metadata
- `unknown`: extract everything; mark `contract_status='unknown'` so downstream can flag

#### `executed_contract` — separate extractor

Same fields as `proposal`, but the document is post-award and the scope is fixed. Higher base confidence (see multipliers below).

#### `capability_statement` — extractor

Extract: `company_name`, `year_founded`, `employee_count`, `primary_specialties`, `capabilities`, `licenses`, `certifications`, `work_areas`, `agency_history` (named past clients).

No contract value, agency, or dates expected.

#### `license_doc` — extractor (Haiku is sufficient)

Extract: `license_class`, `license_number`, `expires_on`, `holder_name`. Single short JSON; no claims wrapping.

#### Source-type confidence multiplier

Each claim's stored `confidence` is `(LLM confidence) × (source-type weight)`:

| Source | Status | Multiplier | Rationale |
|---|---|:-:|---|
| `executed_contract` | (implicit won) | 1.0 | Agreed scope, factual |
| `proposal` | `won` | 0.9 | Aspirational, but delivered |
| `proposal` | `lost` | 0.7 | Aspirational, never tested |
| `proposal` | `in_progress` | 0.7 | Aspirational, not yet submitted |
| `proposal` | `unknown` | 0.75 | Status unclear |
| `capability_statement` | n/a | 0.75 | Broad marketing claims |
| `license_doc` | n/a | 1.0 | Factual credential |
| `other` | n/a | 0.5 | User-confirmed but low trust |

#### Example claims output

```json
{
  "document_type": "proposal",
  "contract_status": "won",
  "claims": [
    {
      "field_path": "specialties.value",
      "value": "concrete flatwork installation",
      "snippet": "Acme Concrete will perform sidewalk and curb ramp installation including concrete flatwork...",
      "confidence": 0.85    // 0.94 LLM × 0.9 proposal-won multiplier
    },
    {
      "field_path": "licenses.class",
      "value": "A",
      "snippet": "Class A General Engineering Contractor License #1234567",
      "confidence": 0.89    // 0.99 × 0.9
    }
  ]
}
```

### 6.5 Review screen (mandatory before profile changes)

After extraction:

1. Group claims by `field_path`
2. Show snippet next to each claim, plus the source-type label and confidence multiplier ("Proposal · won · ×0.9") so the user understands why a claim is graded the way it is
3. User actions per claim: **Accept**, **Edit**, **Reject**
4. Bulk: "Accept all from this document"
5. On accept: write to the corresponding profile table; flip `claims.status = 'accepted'`
6. On reject: keep the row (`status = 'rejected'`) for extractor tuning later

If `document_type = rfp_solicitation`: no review screen; the redirect UI from §6.4 fires instead.

---

## 7. PII redaction

Pre-LLM regex pass on extracted text. Replace matches with typed placeholders to preserve text structure:

```
SSN          \b\d{3}-\d{2}-\d{4}\b                      → [REDACTED-SSN]
EIN          \b\d{2}-\d{7}\b                             → [REDACTED-EIN]
US phone     \b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b → [REDACTED-PHONE]
Email        [\w.+\-]+@[\w-]+\.[\w.-]+                   → [REDACTED-EMAIL]
DL number    \b[A-Z]\d{7,8}\b                            → [REDACTED-DL]
Signature    /Signature:\s*\S+/i                         → Signature: [REDACTED-NAME]
Bank account \b\d{8,17}\b (with context check)           → [REDACTED-ACCT]
```

Count and store `pii_redacted_count` per contract for audit. Surfaces in the UI if a doc had a high redaction count (might indicate the user uploaded the wrong file).

Run BEFORE the 50K-char truncation, so we don't redact only part of a redactable string.

---

## 8. Embeddings

**Model**: Voyage-3-large (Anthropic-recommended). 1024 dimensions. English-tuned.

**Generated for**:
- Each `specialty.value` (one embedding per specialty)
- Each `capability.value` (one embedding per capability)
- Each RFP — concatenation depends on source data quality (see § 9.4)

**Storage**: pgvector `vector(1024)` columns with HNSW indexes.

**Refresh triggers**:
- Profile embedding: any change to `specialties` or `capabilities` rows
- RFP embedding: when the manifest record changes (refreshed_at bumped)

**Cost estimate**: ~$0.18 per 1M tokens. A typical user has ~30 specialty+capability rows, ~150 tokens each = 4.5K tokens = $0.001 to embed a profile. RFPs ~2K tokens each, 1000 RFPs = 2M tokens = ~$0.36 to embed the full catalog. Negligible.

---

## 9. Matching algorithm v2

Replaces [rfp-matching.ts](../front_end/src/lib/rfp-matching.ts) entirely.

### 9.1 Pipeline

```
match(profile, rfp) →
    1. Hard gates (any failure → not eligible as prime, route to sub track)
       — gates fire ONLY on non-empty data
    2. Range matches (scope, duration, complexity)
    3. Semantic matches (specialty embedding, capability embedding)
       — confidence weighted by source data quality
    4. Relationship signals (agency, soft certs, vendor history)
    5. Risk subtraction (incumbent state machine — § 10)
    6. Sub-on-prime parallel track (always computed)
    7. Aggregate → score, win_probability, breakdown, citations, data_quality
```

### 9.2 Stage 1 — Hard gates (empty = no gate fires)

| Gate | Fires only when | Disqualifies if |
|---|---|---|
| License class | `rfp.licenses_required` is non-empty | profile licenses don't satisfy |
| Hard certifications | `rfp.certifications_required` includes hard certs | profile doesn't hold (with expiration check) |
| Set-aside lockout | `rfp.set_aside_lockout` is non-empty | profile doesn't qualify |
| Hard work area | profile has any `is_hard=true` work area | RFP location not in any of them |
| Past gov experience | `rfp.requires_past_gov_exp = true` | `profile.gov_experience = 'none'` |

**Critical rule**: if the field is empty/null on the RFP, we treat it as unknown and the gate does not fire. Per [COVERAGE.md](../webscraping/v2/COVERAGE.md): `licenses_required: []` on a PlanetBids RFP means "PDFs are gated, we don't know," not "no license required." Penalizing or disqualifying based on empty data would silently exclude ~40% of the catalog.

When a gate is "unknown" rather than "passed" or "failed," surface this in the breakdown:

```
license_class: { status: 'unknown', reason: 'source does not expose RFP requirements' }
```

Failure (when data is non-empty and doesn't match) routes to the sub track. UI shows: "Not eligible as prime: missing Class A license. Eligible as subcontractor — see sub track."

### 9.3 Stage 2 — Range matches

```python
def score_scope(rfp_value_usd, profile_min, profile_max):
    if not rfp_value_usd:
        return ('neutral', None)
    if profile_min and rfp_value_usd < profile_min * 0.5:
        return ('weak', 0.2)        # too small
    if profile_max and rfp_value_usd > profile_max * 1.5:
        return ('weak', 0.2)        # too big
    if (not profile_min or rfp_value_usd >= profile_min) and \
       (not profile_max or rfp_value_usd <= profile_max):
        return ('strong', 1.0)
    return ('partial', 0.6)         # within 1.5× of band

def score_duration(rfp_duration_months, pref):
    if not rfp_duration_months:
        return ('neutral', None)
    if pref == 'short' and rfp_duration_months <= 6:    return ('strong', 1.0)
    if pref == 'short' and rfp_duration_months <= 12:   return ('partial', 0.6)
    if pref == 'short':                                 return ('weak', 0.2)
    if pref == 'retention_ok':                          return ('strong', 1.0)
    return ('strong', 1.0)  # 'any'

def score_complexity(rfp_complexity_tier, pref):
    # rfp_complexity_tier inferred from sub count, phase count, deliverables length
    # 'simple' | 'moderate' | 'complex'
    if pref == 'simple_only' and rfp_complexity_tier == 'simple':   return ('strong', 1.0)
    if pref == 'simple_only':                                       return ('weak', 0.1)
    if pref == 'any_with_subs':                                     return ('strong', 1.0)
    return ('partial', 0.7)  # 'any' default
```

### 9.4 Stage 3 — Semantic matches (source-aware)

Embedding text construction depends on what the source actually provides:

```python
def rfp_embedding_text(rfp):
    parts = [rfp.title]                                    # always present
    if rfp.description:        parts.append(rfp.description)
    if rfp.capabilities:       parts.append(' '.join(rfp.capabilities))
    if rfp.deliverables:       parts.append(' '.join(rfp.deliverables))
    if rfp.attachment_rollup:  parts.append(rfp.attachment_rollup.summary)
    return ' '.join(parts)

def semantic_confidence(rfp):
    # How much do we trust the embedding match for this source?
    if rfp.attachment_rollup or rfp.deliverables:  return 1.0    # Cal eProcure
    if rfp.description:                            return 0.85   # PlanetBids
    return 0.6                                                    # BidSync (title only)
```

```python
def score_specialty(profile, rfp):
    if not profile.specialties: return ('neutral', None, [])
    sims = [(s, cosine(s.embedding, rfp.embedding)) for s in profile.specialties]
    best_sim = max(sim for _, sim in sims)
    matched = [(s.value, sim) for s, sim in sims if sim >= 0.5]
    # Adjust threshold by source data quality
    conf = semantic_confidence(rfp)
    adjusted = best_sim * conf
    if adjusted >= 0.75:    return ('strong',  best_sim, matched)
    if adjusted >= 0.55:    return ('partial', best_sim, matched)
    if adjusted >= 0.35:    return ('weak',    best_sim, matched)
    return ('missing', best_sim, [])

def score_capability(profile, rfp):
    # Same shape; thresholds slightly lower (capabilities are broader)
    ...
```

### 9.5 Stage 4 — Relationship signals

```python
def score_agency(profile, rfp):
    rels = [r for r in profile.agency_relationships
            if matches(r.agency_canonical, rfp.agency)]
    if not rels: return ('neutral', None)
    best = max(rels, key=lambda r: r.strength)
    if best.role == 'prime' and best.strength >= 4:  return ('strong',  1.0)
    if best.role == 'prime':                         return ('partial', 0.7)
    if best.role == 'sub':                           return ('partial', 0.5)
    return ('weak', 0.3)

def soft_cert_bonus(profile, rfp):
    # +0.05 raw points per RFP-preferred cert the profile holds (cap 0.15)
    matches = [c for c in profile.soft_certs if c.canonical_id in rfp.preferred_certs]
    return min(0.15, 0.05 * len(matches))

def vendor_history_bonus(profile, rfp):
    # If the user is a known vendor, did they prospect/bid past RFPs from this agency?
    if not profile.vendor_fingerprint: return None
    past = count_past_rfps(profile.vendor_fingerprint, rfp.agency, lookback_years=3)
    if past >= 3: return ('strong', 0.10)
    if past >= 1: return ('partial', 0.05)
    return None
```

### 9.6 Stage 5 — Risk: incumbent (see § 10)

Replaces a continuous confidence multiplier with a ternary state.

### 9.7 Stage 6 — Sub-on-prime track (always)

Run a parallel scoring track even when prime gates pass:

```python
def score_as_sub(profile, rfp, prime_blockers):
    # Looser gates: most prime-only requirements drop
    # License class: need a C-XX matching a deliverable, not the prime class
    # Past gov experience: not required for subs
    # Set-aside: prime needs to qualify, not the sub
    # Specialty match weighted higher (subs are valued for their specialty fit)
    # Lower agency-relationship weight (subs follow primes, not vice versa)
    ...
    return SubMatch(score, eligible, breakdown)
```

### 9.8 Aggregation, weights, and output

```python
weights = {
    'specialty':    0.30,
    'capability':   0.15,
    'scope':        0.15,
    'complexity':   0.10,
    'agency':       0.10,
    'location':     0.10,
    'duration':     0.05,
    'description':  0.05,
}

raw = sum(weights[k] * v for k, v in scores.items() if v is not None)
soft_bonus = soft_cert_bonus(profile, rfp)
score = clamp(round((raw + soft_bonus) * 100), 0, 100)
incumbent_state = compute_incumbent_state(rfp)         # § 10
win_probability = score * incumbent_multiplier(incumbent_state)
```

The **match output** carries data quality alongside the score:

```json
{
  "score": 78,
  "win_probability": 31,
  "tier": "strong",
  "incumbent_state": "likely",
  "incumbent_vendor": "Acme Corp",
  "data_quality": {
    "source_id": "planetbids_san_diego",
    "has_pdf_extraction": false,
    "has_market_intel": true,
    "coverage": "market_intel_only"
  },
  "breakdown": [...],
  "citations": [...]
}
```

`win_probability` surfaced separately. A 78-score / 31-win-probability event reads as: "good fit, but likely renewal — not worth bidding."

UI uses `data_quality` to show "limited data — bid carefully" badges on PlanetBids events with no PDF extraction.

### 9.9 Tiers

```
score >= 75 → 'excellent'
score >= 55 → 'strong'
score >= 35 → 'moderate'
score >= 15 → 'low'
otherwise   → 'minimal'
disqualified (prime gates failed, no sub option) → 'not_eligible'
```

### 9.10 Citations

Every category in the breakdown includes:

```json
{
  "category": "Specialty",
  "status": "strong",
  "score": 0.84,
  "rfp_phrase": "sidewalk and curb ramp installation",
  "profile_claim": "concrete flatwork installation",
  "profile_claim_source": "contract: 2023 Caltrans District 4 sidewalk repair"
}
```

Surfaced verbatim in the UI: *"Strong specialty match: RFP says 'sidewalk and curb ramp installation'; your specialty 'concrete flatwork installation' from your 2023 Caltrans contract."*

---

## 10. Incumbent state machine

The matcher computes a ternary `incumbent_state ∈ {likely, open_field, unknown}` per RFP. Source-routed because each source surfaces incumbency through different fields.

### 10.1 State machine

```python
def compute_incumbent_state(rfp):
    # 1. Cal eProcure: LLM-extracted incumbent_vendor from RFP text (LIVE)
    if rfp.incumbent_vendor:
        return IncumbentState(
            state='likely', confidence=0.85,
            source='text_extraction',
            named_vendor=rfp.incumbent_vendor,
            contract_end=rfp.incumbent_contract_end
        )

    # 2. PlanetBids: structured award history
    history = lookup_award_history(rfp.agency, rfp.category, lookback_years=5)
    if same_vendor_won_n_recent(history, n=2):
        return IncumbentState(
            state='likely', confidence=0.80,
            source='award_history',
            named_vendor=most_recent_winner(history)
        )

    # 3. PlanetBids: thin bid response on closed comparable
    last_comparable = most_recent(history)
    if last_comparable and len(last_comparable.bid_results) <= 2:
        return IncumbentState(
            state='likely', confidence=0.65,
            source='thin_bid_response'
        )

    # 4. Open-field signal: ≥3 prior with distinct winners
    if distinct_winners_in_history(history, n=3):
        return IncumbentState(
            state='open_field', confidence=0.75,
            source='distinct_winners'
        )

    # 5. No signal available
    return IncumbentState(state='unknown', confidence=None)


def incumbent_multiplier(state):
    if state.state == 'likely':
        # 80% conf → 0.6×, 90% conf → 0.55×
        return 1.0 - 0.5 * state.confidence
    return 1.0
```

### 10.2 Source coverage today

| Source | Detection path | Status |
|---|---|---|
| Cal eProcure | `rfp.incumbent_vendor` (LLM-extracted) | **Live** (commit `9118ea1`) |
| PlanetBids (with history) | `award_history` lookup via `rfp_bidders` join | Available once vendor index resolves fingerprints; manifests already include `bid_results` and `award` |
| PlanetBids (no history) | `thin_bid_response` on last comparable, otherwise `unknown` | Improves as `--include-awarded` accumulates data |
| BidSync | none | `unknown` always |
| Agentic (LA, SF) | none | broken; no events to score |

### 10.3 Surfacing in the product

- RFP card chip: red "⚠ Incumbent likely: [vendor]" when `state='likely' AND confidence >= 0.6`
- RFP card chip: green "✓ Open field" when `state='open_field'`
- No chip when `state='unknown'` (don't fake precision)
- Match breakdown: "Win probability adjusted: incumbent presence detected (Caltrans, contract ends 2026-06-30)"
- Dashboard filter: "Hide likely incumbents" toggle

### 10.4 Coordination with webscraping

Open items tracked between this spec and [COVERAGE.md](../webscraping/v2/COVERAGE.md):

- Vendor fingerprint algorithm — when does `vendors/index.json` start being produced?
- `rfp_bidders` table population: how often is the join refreshed?
- Backfill depth — how far back does `--include-awarded` reach on PlanetBids?
- PlanetBids document gating — affects whether `incumbent_vendor` text extraction can ever extend to PlanetBids
- Agentic Lambda fix — affects whether LA/SF events ever reach the matcher

---

## 11. API surface

Auth unchanged (JWT). New endpoints:

```
GET    /api/profile/                     - full profile (joins all tables)
PATCH  /api/profile/                     - patch any profile.* field
POST   /api/profile/specialties/         - add specialty
DELETE /api/profile/specialties/{id}/    - remove specialty
... same pattern for capabilities, licenses, certifications, work_areas, agency_relationships

POST   /api/profile/vendor/resolve/      - claim a vendor fingerprint by company-name match

POST   /api/onboarding/step/{n}/         - save a single onboarding step
GET    /api/onboarding/state/            - resume state

POST   /api/contracts/                   - upload + classify + extract; returns claims to review
GET    /api/contracts/{id}/claims/       - claims for review
PATCH  /api/contracts/{id}/claims/{id}/  - accept | reject | edit
DELETE /api/contracts/{id}/              - delete contract; cascade to claims; profile rows already-accepted are NOT removed

GET    /api/match/                       - scored RFPs for current user
GET    /api/match/{rfp_id}/              - single match with breakdown + citations + data_quality
PATCH  /api/match/{rfp_id}/              - status, feedback

GET    /api/events/                      - existing scraped RFPs (still S3-backed; populates rfp_cache on read)
```

Drop:

```
POST   /api/profile/refresh/             - no longer needed (no aggregation step)
POST   /api/profile/extract/             - replaced by per-doc /api/contracts/ flow
```

---

## 12. UI changes

**Onboarding** (`/onboarding`): new, replaces upload-first as the primary signup path. Nine screens above.

**Profile** (`/profile`): show provenance per field (e.g. "Cloud Services — from contract X"). Direct edit allowed. Mark hard work areas with a lock icon. Vendor identity widget when fingerprint resolves.

**Contracts** (`/contracts`, renamed from `/upload`): upload + review flow. Each upload spawns a review modal listing claims to accept/reject.

**Dashboard** (`/dashboard`):
- show `score` and `win_probability` separately
- `data_quality` badge per card ("full data" / "requirements only" / "market intel only" / "thin")
- incumbent chips (red "⚠ Incumbent likely: [vendor]" / green "✓ Open field")
- filter for "hide likely incumbents"

**RFP detail**: prime track + sub track tabs. Each scoring category includes the citation (RFP phrase + profile claim source). `data_quality` summary shown at the top: "This RFP came from PlanetBids — bidder/award data available, but PDF requirements (NAICS, licenses, certifications) are not accessible. Requirements shown are inferred from the title and description only."

---

## 13. Phased rollout

| Phase | Duration | Output |
|---|---|---|
| 0 | 2–3 days | This spec, agreement on schema and prompts |
| 1 | 1 week | RDS + pgvector provisioned, schema migrations, profile API rewritten |
| 2 | 1 week | Onboarding flow shipped |
| 3 | 1–2 weeks | Claude SDK migration, classifier, targeted extractors, review screen |
| 4 | 2 days | PII redaction layer |
| 5 | 2–3 weeks | Embeddings + matching v2 algorithm with source-aware scoring + incumbent state machine |
| 6 | 1 week | Match UI rewrite (citations, prime/sub tracks, data_quality badges, incumbent chips) |
| 7 (parallel, in webscraping) | ongoing | Vendor fingerprint dedup, `incumbent_vendor` extension to other sources, Lambda fixes |

Total: ~8–10 weeks for one engineer on the matching/profile side, with webscraping parallel.

---

## 14. Open questions

- **Embedding provider lock-in**: Voyage-3-large is the recommended option but ties us to one vendor. OpenAI `text-embedding-3-large` is a fallback if Voyage availability becomes an issue. Both fit pgvector(1024).
- **Specialty taxonomy seed list**: do we ship a hand-curated list of ~200 specialty terms for the onboarding picker, or let users free-text from day one and curate later? Recommend hand-curated for v1.
- **License-class taxonomy completeness**: California CSLB has ~60 license classes. Need to enumerate all of them in the onboarding picker. Out-of-CA expansion is later.
- **Sub-eligibility heuristics**: the sub track needs different gates than the prime track. The full set is sketched in § 9.7 but should be validated against discovery interviews before implementation.
- **Match feedback loop**: the existing `feedback_rating` field is preserved; we should plan a regression test that takes a sample of bad matches, runs them through v2, and confirms they don't recur.
- **RFP "category" definition**: incumbent state machine joins by `(agency, category)`. Today we have `naics_codes` and `capabilities` arrays. Picking one as the join key, vs. fuzzy matching on capability sets, is a calibration decision.
- **PlanetBids document unblock**: vendor-registration-per-agency would dramatically improve coverage. Legal/ops decision; not engineering. Worth tracking as a product-strategy item.
