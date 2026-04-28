# Civitas Architecture v2 — Detailed Spec

Companion to [Matching-Values.md](Matching-Values.md). This is the working spec for the data ingestion + matching overhaul. Edit freely; nothing here is implemented yet.

---

## 1. Principles

1. **Profile is the source of truth.** Documents are evidence supporting profile claims, not the source of profile data. User edits never get overwritten by re-extraction.
2. **Onboarding-first, evidence-second.** Every user fills the matching-critical fields directly via a guided interview. Documents backfill provenance and add detail.
3. **Every claim has provenance.** Every extracted fact stores a snippet, a confidence score, and a doc reference. The profile UI can show "Cloud Services — only evidenced by contract X. Remove?"
4. **Hard signals are typed, soft signals are scored.** License class is binary, not partial credit. Set-aside lockouts disqualify. Specialty matching is semantic.
5. **Match results carry citations.** Each scoring category cites the source phrase from the RFP and the source profile claim. Addresses the "why is this a fit" gap from the discovery interviews.
6. **Two output tracks per RFP**: `prime_match` and `sub_match`. Prime gate failure routes to sub track instead of disqualifying.

---

## 2. Storage architecture

**Postgres on RDS with `pgvector` extension.** Replaces the current S3-as-database pattern.

- Profile, contracts, claims, match state → Postgres
- Raw uploaded files → S3 (unchanged: `uploads/{user_id}/{contract_id}/...`)
- Scraped RFPs → still S3 manifests (no change to webscraping pipeline); new `rfp_cache` table is a denormalized read cache for matching, refreshed from manifests
- Awards data (incumbent tracking) → S3 manifests + `rfp_awards` table

**Why Postgres over DynamoDB**: relational shape (profile → contracts → claims), pgvector for embeddings in the same DB, full-text search for RFP descriptions, ACID for atomic claim acceptance, cleaner schema migrations, ~$15/mo on `db.t4g.micro`.

---

## 3. Postgres schema

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
    -- meta
    completeness_score   REAL DEFAULT 0,
    onboarded_at         TIMESTAMPTZ,
    embedding_updated_at TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
-- ---------------------------------------------------------------

CREATE TABLE agency_relationships (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agency_canonical  TEXT NOT NULL,    -- normalized: 'caltrans', 'dgs', 'lausd'
    agency_display    TEXT NOT NULL,
    role              TEXT NOT NULL,    -- 'prime' | 'sub'
    contract_count    INT NOT NULL DEFAULT 1,
    last_contract_at  DATE,
    strength          SMALLINT NOT NULL DEFAULT 1,  -- 1-5, hand or heuristic
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
    document_type       TEXT NOT NULL,    -- see § 5.1
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
    field_path  TEXT NOT NULL,     -- 'specialties.value' | 'licenses.class' | 'agency_relationships.agency'
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
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rfp_id           TEXT NOT NULL,
    status           TEXT,             -- 'saved' | 'applied' | 'in_progress'
    match_score      REAL,
    match_tier       TEXT,
    win_probability  REAL,
    feedback_rating  TEXT,             -- 'good' | 'bad'
    feedback_reason  TEXT,
    feedback_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
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
-- ---------------------------------------------------------------

CREATE TABLE rfp_cache (
    id                       TEXT PRIMARY KEY,
    source_id                TEXT NOT NULL,
    title                    TEXT NOT NULL,
    description              TEXT,
    agency                   TEXT,
    location                 TEXT,
    deadline                 TIMESTAMPTZ,
    estimated_value_usd      BIGINT,
    -- enriched
    capabilities             TEXT[],
    naics_codes              TEXT[],
    certifications_required  TEXT[],
    set_aside_lockout        TEXT[],
    license_classes_required TEXT[],
    requires_past_gov_exp    BOOLEAN,
    -- incumbent
    incumbent_detected       BOOLEAN,
    incumbent_confidence     REAL,
    incumbent_phrases        TEXT[],
    incumbent_named_vendor   TEXT,
    -- semantic
    embedding                vector(1024),
    -- raw
    raw                      JSONB,
    refreshed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rfp_cache_embedding ON rfp_cache USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_rfp_cache_deadline  ON rfp_cache(deadline);
CREATE INDEX idx_rfp_cache_agency    ON rfp_cache(agency);

-- ---------------------------------------------------------------
-- RFP awards (incumbent tracking, populated by webscraping)
-- ---------------------------------------------------------------

CREATE TABLE rfp_awards (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id           TEXT NOT NULL,
    rfp_id              TEXT,
    agency              TEXT NOT NULL,
    category            TEXT,    -- best-effort capability or NAICS prefix
    awarded_to          TEXT,
    awarded_at          DATE,
    contract_value_usd  BIGINT,
    duration_text       TEXT,
    discovered_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_id, rfp_id, awarded_to)
);

CREATE INDEX idx_rfp_awards_agency_category ON rfp_awards(agency, category);
CREATE INDEX idx_rfp_awards_vendor          ON rfp_awards(awarded_to);
```

---

## 4. Onboarding flow

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

---

## 5. Evidence flow (LLM extraction)

### 5.1 Document types

```
won_contract         — signed/awarded contract or successful proposal
lost_bid             — submitted but didn't win
capability_statement — marketing brochure describing what the company does
rfp_response_draft   — in-progress proposal not yet submitted
license_doc          — license certificate, registration, or formal credential
other                — anything else; user is asked to confirm
```

### 5.2 Two-stage extraction

```
upload → text extract (mupdf) → PII redact → classify → extract per type → claims → review screen → accept/reject
```

### 5.3 Stage 1: Classifier

**Model**: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`), temperature 0.

**Prompt** (cached system message):

```
You classify procurement documents. Given the first ~3000 characters of a
document, return its type and confidence.

Categories:
- won_contract:         a signed/awarded contract or a successful proposal that
                        was accepted by the agency
- lost_bid:             a proposal that was submitted but did not win
- capability_statement: marketing material describing what the company does;
                        no specific contract being executed
- rfp_response_draft:   an in-progress proposal not yet submitted
- license_doc:          a license certificate, registration, or formal credential
- other:                anything else (resumes, brochures, financial statements)

Return JSON only:
{ "type": "<category>", "confidence": <0-1>, "reasoning": "<one sentence>" }
```

If `confidence < 0.7`, surface the choice to the user before extraction.

### 5.4 Stage 2: Targeted extractors

**Model**: Claude Sonnet 4.6 (`claude-sonnet-4-6`), temperature 0.1, prompt caching on the system message.

Each extractor outputs a **claims array**, not a flat object. Every fact gets its own claim row:

```json
{
  "claims": [
    {
      "field_path": "specialties.value",
      "value": "concrete flatwork installation",
      "snippet": "Acme Concrete will perform sidewalk and curb ramp installation including concrete flatwork...",
      "confidence": 0.94
    },
    {
      "field_path": "licenses.class",
      "value": "A",
      "snippet": "Class A General Engineering Contractor License #1234567",
      "confidence": 0.99
    },
    {
      "field_path": "agency_relationships.agency",
      "value": "California Department of Transportation",
      "snippet": "This contract is awarded by the California Department of Transportation (Caltrans)...",
      "confidence": 0.98
    },
    {
      "field_path": "agency_relationships.role",
      "value": "prime",
      "snippet": "Acme Concrete shall serve as the prime contractor for...",
      "confidence": 0.91
    }
  ]
}
```

#### Won-contract extractor

Extract any of: `contractor_name`, `role` (prime/sub), `agency`, `contract_value`, `duration`, `award_date`, `start_date`, `end_date`, `license_classes`, `certifications_held`, `specialties` (1–3 from the scope), `capabilities` (broader from scope), `naics_codes`, `work_locations`, `scope_summary`.

#### Capability-statement extractor

Extract: `company_name`, `year_founded`, `employee_count`, `primary_specialties`, `capabilities`, `licenses`, `certifications`, `work_areas`, `agency_history` (named past clients).

No contract value or dates expected.

#### Lost-bid extractor

Same shape as won-contract, but: tag `agency_relationships.role` as `'sub_or_interest'` instead of `'prime'`. Don't claim a value.

#### License-doc extractor (Haiku is sufficient)

Extract: `license_class`, `license_number`, `expires_on`, `holder_name`. Single short JSON; no claims wrapping.

#### RFP-response-draft extractor

Same as won-contract minus dates; mark all confidence × 0.7 since this is what they pitched, not what was awarded.

### 5.5 Review screen (mandatory before profile changes)

After extraction:

1. Group claims by `field_path`
2. Show snippet next to each claim
3. User actions per claim: **Accept**, **Edit**, **Reject**
4. Bulk: "Accept all from this document"
5. On accept: write to the corresponding profile table; flip `claims.status = 'accepted'`
6. On reject: keep the row (`status = 'rejected'`) for extractor tuning later

---

## 6. PII redaction

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

## 7. Embeddings

**Model**: Voyage-3-large (Anthropic-recommended). 1024 dimensions. English-tuned.

**Generated for**:
- Each `specialty.value` (one embedding per specialty)
- Each `capability.value` (one embedding per capability)
- Each RFP — concatenation of `title + description + capabilities.join(' ') + deliverables.join(' ') + attachment_rollup.summary`, truncated to 8K tokens

**Storage**: pgvector `vector(1024)` columns with HNSW indexes.

**Refresh triggers**:
- Profile embedding: any change to `specialties` or `capabilities` rows
- RFP embedding: when the manifest record changes (refreshed_at bumped)

**Cost estimate**: ~$0.18 per 1M tokens. A typical user has ~30 specialty+capability rows, ~150 tokens each = 4.5K tokens = $0.001 to embed a profile. RFPs ~2K tokens each, 1000 RFPs = 2M tokens = ~$0.36 to embed the full catalog. Negligible.

**Matching usage**: see § 8.

---

## 8. Matching algorithm v2

Replaces [rfp-matching.ts](../front_end/src/lib/rfp-matching.ts) entirely.

### 8.1 Pipeline

```
match(profile, rfp) →
    1. Hard gates (any failure → not eligible as prime, route to sub track)
    2. Range matches (scope, duration, complexity)
    3. Semantic matches (specialty embedding, capability embedding)
    4. Relationship signals (agency, soft certs)
    5. Risk subtraction (incumbent confidence)
    6. Sub-on-prime parallel track (always computed)
    7. Aggregate → score, win_probability, breakdown, citations
```

### 8.2 Stage 1 — Hard gates

| Gate | Disqualifies if |
|---|---|
| License class | RFP requires C-12 and profile has only A; or RFP requires "any general contractor" and profile has no A or B |
| Hard certifications | RFP lists hard cert; profile doesn't hold it (with expiration check) |
| Set-aside lockout | RFP restricted to a category (e.g. DVBE-only); profile doesn't qualify |
| Hard work area | User has any `is_hard=true` work area; RFP location not in any of them |
| Past gov experience | RFP demands prior gov contracts; `profile.gov_experience = 'none'` |

Failure routes to the sub track. The user sees: "Not eligible as prime: missing Class A license. Eligible as subcontractor — see sub track."

### 8.3 Stage 2 — Range matches

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

### 8.4 Stage 3 — Semantic matches

```python
def score_specialty(profile, rfp):
    if not profile.specialties: return ('neutral', None, [])
    sims = [(s, cosine(s.embedding, rfp.embedding)) for s in profile.specialties]
    best_sim = max(sim for _, sim in sims)
    matched = [(s.value, sim) for s, sim in sims if sim >= 0.5]
    if best_sim >= 0.75:    return ('strong',  best_sim, matched)
    if best_sim >= 0.55:    return ('partial', best_sim, matched)
    if best_sim >= 0.35:    return ('weak',    best_sim, matched)
    return ('missing', best_sim, [])

def score_capability(profile, rfp):
    # same shape, lower thresholds; capabilities are broader
    ...
```

### 8.5 Stage 4 — Relationship signals

```python
def score_agency(profile, rfp):
    # match by agency_canonical
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
```

### 8.6 Stage 5 — Risk: incumbent

```python
def confidence_multiplier(rfp):
    if not rfp.incumbent_detected:                    return 1.0
    if rfp.incumbent_confidence < 0.6:                return 1.0
    # 60% conf → 0.7×, 90% conf → 0.55×
    return 1.0 - 0.5 * rfp.incumbent_confidence
```

### 8.7 Stage 6 — Sub-on-prime track (always)

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

### 8.8 Aggregation & weights

```python
weights = {
    'specialty':    0.30,
    'capability':   0.15,
    'scope':        0.15,
    'complexity':   0.10,
    'agency':       0.10,
    'location':     0.10,
    'duration':     0.05,
    'description':  0.05,   # general semantic match as background
}

raw = sum(weights[k] * v for k, v in scores.items() if v is not None)
soft_bonus = soft_cert_bonus(profile, rfp)
score = clamp(round((raw + soft_bonus) * 100), 0, 100)
win_probability = score * confidence_multiplier(rfp)
```

`win_probability` is surfaced separately from `score`. A 90-point match against an 80%-confidence incumbent shows as `Score 90 / Win likelihood 36`.

### 8.9 Tiers

```
score >= 75 → 'excellent'
score >= 55 → 'strong'
score >= 35 → 'moderate'
score >= 15 → 'low'
otherwise   → 'minimal'
disqualified (prime gates failed, no sub option) → 'not_eligible'
```

### 8.10 Citations

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

## 9. Incumbent risk pipeline

Lives in `webscraping/v2/`. Three phases.

### 9.1 Phase 1 — RFP-text incumbent detection

New module `webscraping/v2/pipeline/incumbent.py`. Run during normalization.

Scan title + description + attachment rollup for incumbent-tell phrases:

```python
INCUMBENT_PHRASES = [
    (r"current contract\s+(expires|expiring|ends|ending)", 0.9),
    (r"incumbent\s+(vendor|contractor|provider)",          0.95),
    (r"existing\s+(service|maintenance|support)\s+contract", 0.7),
    (r"renewal\s+of\s+(services|contract|agreement)",      0.7),
    (r"continuation\s+of\s+services",                       0.7),
    (r"replace\s+existing",                                  0.5),
    (r"transition\s+from\s+(current|existing)\s+(provider|vendor)", 0.85),
    (r"extension\s+of\s+the\s+current\s+contract",          0.85),
    (r"contract\s+#\s*\S+\s+expires",                       0.9),
    (r"awarded\s+to\s+([A-Z][\w\s,.&]+)\s+in\s+\d{4}",      0.8),  # captures vendor
]
```

Also: pattern-based — if RFP issued < 90 days before an extracted "expiration date" of an existing contract, set confidence to 0.85.

Output written to `EnrichedEvent`:

```python
incumbent_signal: {
    detected: bool,
    confidence: float,    # max of matched phrase confidences
    phrases: list[str],
    named_vendor: str | None,
}
```

Catches roughly 30–40% of true incumbents based on a manual sample of 100 California RFPs. High precision when it fires.

### 9.2 Phase 2 — Award-history database

Add an awards crawler per scraper:

| Scraper | Award source |
|---|---|
| Cal eProcure | "Notice of Intent to Award" pages, linked from event detail pages |
| PlanetBids | Award data exposed on each RFP page after close |
| BidSync | Award data on each tabulation/award API endpoint |
| Agentic | Auto-discover from the agency's awards page (recipe extension) |

Schema: `rfp_awards` table (already in § 3). Manifests at `scrapes/v2/awards/{source_id}/awards.json`.

Refresh on the existing 4-hour EventBridge schedule.

**Use in incumbent detection**: when normalizing a new RFP, look up `(agency, category)` in `rfp_awards` ordered by date desc. If the same vendor won the most recent award in this `(agency, category)`, set:

```python
incumbent_signal.named_vendor = most_recent_winner
incumbent_signal.confidence = max(current, 0.75)
```

If the same vendor won the last 2+ awards in this `(agency, category)`, bump confidence to 0.9.

Database becomes useful after ~3–6 months of award scraping.

### 9.3 Phase 3 — Council-meeting scraping (defer, research first)

Marcus's Ontopical pattern. Spike for 1 week on three agencies (LA, SF, San Diego) to assess signal-to-noise. Ship only if precision > 60% on a 20-RFP sample.

### 9.4 Surfacing in the product

- RFP card: red "Incumbent likely" or "Renewal likely: [vendor]" chip when `confidence > 0.6`
- Match breakdown: "Win probability adjusted: incumbent presence detected"
- Filter on dashboard: "Hide likely renewals" toggle

---

## 10. API surface

Auth unchanged (JWT). New endpoints:

```
GET    /api/profile/                     - full profile (joins all tables)
PATCH  /api/profile/                     - patch any profile.* field
POST   /api/profile/specialties/         - add specialty
DELETE /api/profile/specialties/{id}/    - remove specialty
... same pattern for capabilities, licenses, certifications, work_areas, agency_relationships

POST   /api/onboarding/step/{n}/         - save a single onboarding step
GET    /api/onboarding/state/            - resume state

POST   /api/contracts/                   - upload + classify + extract; returns claims to review
GET    /api/contracts/{id}/claims/       - claims for review
PATCH  /api/contracts/{id}/claims/{id}/  - accept | reject | edit
DELETE /api/contracts/{id}/              - delete contract; cascade to claims; profile rows already-accepted are NOT removed

GET    /api/match/                       - scored RFPs for current user
GET    /api/match/{rfp_id}/              - single match with breakdown + citations
PATCH  /api/match/{rfp_id}/              - status, feedback

GET    /api/events/                      - existing scraped RFPs (still S3-backed)
```

Drop:

```
POST   /api/profile/refresh/             - no longer needed (no aggregation step)
POST   /api/profile/extract/             - replaced by per-doc /api/contracts/ flow
```

---

## 11. UI changes

**Onboarding** (`/onboarding`): new, replaces upload-first as the primary signup path. Nine screens above.

**Profile** (`/profile`): show provenance per field (e.g. "Cloud Services — from contract X"). Direct edit allowed. Mark hard work areas with a lock icon.

**Contracts** (`/contracts`, renamed from `/upload`): upload + review flow. Each upload spawns a review modal listing claims to accept/reject.

**Dashboard** (`/dashboard`): show `score` and `win_probability` separately. Filter for "hide likely renewals."

**RFP detail**: prime track + sub track tabs. Each scoring category includes the citation (RFP phrase + profile claim source).

---

## 12. Phased rollout

| Phase | Duration | Output |
|---|---|---|
| 0 | 2–3 days | This spec, agreement on schema and prompts |
| 1 | 1 week | RDS + pgvector provisioned, schema migrations, profile API rewritten |
| 2 | 1 week | Onboarding flow shipped |
| 3 | 1–2 weeks | Claude SDK migration, classifier, targeted extractors, review screen |
| 4 | 2 days | PII redaction layer |
| 5 | 2–3 weeks | Embeddings + matching v2 algorithm |
| 6 | 1 week | Match UI rewrite (citations, prime/sub tracks) |
| 7 (parallel, in webscraping) | 1–4 weeks | Incumbent Phase 1, then Phase 2 |

Total: ~8–10 weeks for one engineer working full-time.

---

## 13. Open questions

- **Embedding provider lock-in**: Voyage-3-large is the recommended option but ties us to one vendor. OpenAI `text-embedding-3-large` is a fallback if Voyage availability becomes an issue. Both fit pgvector(1024).
- **Specialty taxonomy seed list**: do we ship a hand-curated list of ~200 specialty terms for the onboarding picker, or let users free-text from day one and curate later? Recommend hand-curated for v1.
- **License-class taxonomy completeness**: California CSLB has ~60 license classes. Need to enumerate all of them in the onboarding picker. Out-of-CA expansion is later.
- **Sub-eligibility heuristics**: the sub track needs different gates than the prime track. The full set is sketched in § 8.7 but should be validated against discovery interviews before implementation.
- **Match feedback loop**: the existing `feedback_rating` field is preserved; we should plan a regression test that takes a sample of bad matches, runs them through v2, and confirms they don't recur.
