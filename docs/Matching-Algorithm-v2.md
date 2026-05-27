# Matching Algorithm v2

The current, production matcher. Implemented in
[`front_end/src/lib/matching-v2.ts`](../front_end/src/lib/matching-v2.ts).
Replaces the v1 client-side synonym-Jaccard scorer
([Matching-Algorithm](Matching-Algorithm)).

**Source of truth for the design:**
[Architecture-v2 § 9](Architecture-v2.md#9-matching-algorithm-v2).
This page is a practical summary of what's shipping.

---

## What changed from v1

| Concern | v1 | v2 |
|---|---|---|
| Where it runs | Client-side, in the browser | Server-side, behind `/api/match` |
| Treatment of missing RFP data | Counted as 0 | Treated as **unknown**; gate skipped, category neutral |
| Specialty / capability match | Synonym-Jaccard on tokens | pgvector cosine similarity on Voyage-3-large 1024-dim embeddings |
| Eligibility model | One disqualifier check (clearance, set-aside) | Multiple hard gates; failures route to a parallel **Sub-on-prime** track |
| Win signal | Score only | Score + separate `win_probability` adjusted by an **incumbent state machine** |
| Explanation | "matched tokens" lists | Per-category **citation**: RFP phrase + the profile claim that backed it |
| Data quality awareness | None | `data_quality` badge per RFP (`full` / `requirements_only` / `market_intel_only` / `thin`); thresholds and weights flex with it |
| NAICS tagging input | Regex `infer_capabilities` | Haiku 4.5 tagger ([`lib/rfp-tagger.ts`](../front_end/src/lib/rfp-tagger.ts)) + Sonnet 4.6 critic ([`lib/rfp-tag-critic.ts`](../front_end/src/lib/rfp-tag-critic.ts)) |

---

## Pipeline

```
match(profile, rfp) →
  1. Hard gates (fire only on non-empty RFP data)
  2. Range matches (scope, duration, complexity)
  3. Semantic matches (specialty embedding, capability embedding)
       — confidence weighted by source data quality
  4. Relationship signals (agency, soft certs, vendor history)
  5. Risk subtraction (incumbent state machine)
  6. Sub-on-prime parallel track (always computed)
  7. Aggregate → { score, win_probability, tier, breakdown, citations, data_quality }
```

## Hard gates

Each gate fires **only when the RFP field is non-empty**:

| Gate | Source field | Effect on prime gate failure |
|---|---|---|
| License class | `rfp_cache.licenses_required` | route to sub track |
| Hard certs | `rfp_cache.certifications_required` | route to sub track |
| Set-aside lockout | `rfp_cache.set_aside_lockout` | not eligible (sub doesn't help) |
| Hard work area | profile `work_areas.is_hard = true` | not eligible |
| Past gov experience | `rfp_cache.requires_past_gov_exp` | route to sub track |

When the source doesn't expose a field (typical for PlanetBids /
BidSync / agentic), the gate reports `status: 'unknown'` in the
breakdown rather than passing or failing — the UI surfaces this so
users know the score is computed against partial data.

## Source-aware semantic match

Embedding text construction depends on what the source actually
provides:

```
parts = [title]
if description:        parts.append(description)
if scope_summary:      parts.append(scope_summary)     # Haiku-tagged sentence; valuable for thin sources
if capabilities:       parts.append(capabilities)
if deliverables:       parts.append(deliverables)
if attachment_rollup:  parts.append(attachment_rollup) # only Cal eProcure / OpenGov
```

Then the per-source confidence multiplier kicks the threshold:

| Source | Has attachments / rollup | Has description | Confidence |
|---|:-:|:-:|:-:|
| Cal eProcure | ✓ | ✓ | 1.0 |
| OpenGov | ✓ | ✓ | 1.0 |
| PlanetBids | ✗ | ✓ (detail page) | 0.85 |
| BidSync | ✗ | ✗ (title only) | 0.6 |

Adjusted similarity = `best_cosine × confidence`. Strong ≥0.75,
partial ≥0.55, weak ≥0.35, otherwise missing.

## Incumbent state machine

Per RFP, the matcher computes `incumbent_state ∈ {likely, open_field,
unknown}` via a source-routed cascade (full detail in
[Architecture-v2 § 10](Architecture-v2.md#10-incumbent-state-machine)):

1. **Cal eProcure / OpenGov** — Haiku-extracted `incumbent_vendor`
   from the RFP text. Live.
2. **PlanetBids award history** — same vendor winning the last 2+
   comparable awards. Live when the vendor fingerprint resolves.
3. **PlanetBids thin bid response** — ≤2 bids on the most recent
   comparable. Live.
4. **Open field** — ≥3 prior distinct winners.
5. **Unknown** — no signal; no chip rendered.

```
win_probability = score × (1.0 − 0.5 × confidence)   if likely
win_probability = score                              otherwise
```

A 78-score / 31-win-probability RFP reads as "good fit, but probably
not worth bidding."

## Output

```json
{
  "score": 78,
  "win_probability": 31,
  "tier": "strong",
  "incumbent": {
    "state": "likely",
    "confidence": 0.85,
    "source": "text_extraction",
    "namedVendor": "Acme Corp",
    "contractEnd": "2026-06-30"
  },
  "dataQuality": {
    "sourceId": "planetbids_san_diego",
    "hasPdfExtraction": false,
    "hasMarketIntel": true,
    "coverage": "market_intel_only"
  },
  "primeEligible": true,
  "subEligible": true,
  "gateFailures": [],
  "breakdown": [
    {
      "category": "Specialty",
      "status": "strong",
      "score": 0.84,
      "rfpPhrase": "sidewalk and curb ramp installation",
      "profileClaim": "concrete flatwork installation",
      "profileClaimSource": "contract: 2023 Caltrans District 4 sidewalk repair"
    },
    ...
  ],
  "subTrack": { "eligible": true, "score": 71, "breakdown": [...] }
}
```

Tiers: `score ≥ 75 → excellent`, `≥55 → strong`, `≥35 → moderate`,
`≥15 → low`, otherwise `minimal`. Prime gate failure with no sub
option → `not_eligible`.

## Live match cache

Scoring all 3,000+ RFPs against every user on every page load is
wasteful. The shipping system populates a live cache in `match_state`:

| Column | Purpose |
|---|---|
| `cached_score`, `cached_tier`, `cached_win_probability`, `cached_incumbent_state` | Headline numbers; sorted on for the list view |
| `match_data` (JSONB) | Full `MatchResult` including the breakdown — hydrates the detail page without recomputing |
| `scored_at` | Audit |

The rescore worker
([`lib/match-rescore.ts`](../front_end/src/lib/match-rescore.ts)) is
the **sole writer** of the cached columns. Reads from `/api/match`
fall back to live `matchV2()` plus a fire-and-forget enqueue
([`lib/match-rescore-trigger.ts`](../front_end/src/lib/match-rescore-trigger.ts))
when a row is missing.

Cache invalidation triggers:

- Any profile change (specialties, capabilities, licenses, certs,
  work areas, agency relationships).
- A scrape refresh of the underlying RFP row.
- A Sonnet critique that changes NAICS tags (which also nulls the
  embedding so it gets recomputed first).
- Disaster recovery via `POST /api/cron/rebuild-match-state`.

User-action endpoints (status changes, feedback, saves) **never**
write to the cached columns — only to `feedback_*`, `status`,
`status_changed_at`, `viewed_at`. This keeps the feedback snapshot
clean from the live cache churn.

## NAICS tagging pipeline

The matcher reads `rfp_cache.naics_codes` and
`rfp_cache.scope_summary`. Both are produced by the tagging pipeline
that runs after each scrape:

1. [`lib/rfp-tagger.ts`](../front_end/src/lib/rfp-tagger.ts) — Haiku
   4.5 reads each RFP's `title + description + attachment_rollup` and
   emits `primary_naics` (one 6-digit code), `secondary_naics` (0-4
   codes), `scope_summary` (1-2 sentences in vendor-facing language).
   The full 1,012-code NAICS catalog is cached in the system prompt
   so Haiku picks from a known list rather than hallucinating codes.
2. [`lib/rfp-tag-critic.ts`](../front_end/src/lib/rfp-tag-critic.ts) —
   Sonnet 4.6 audits each Haiku tagging once. When it disagrees, it
   overrides the tags and nulls the row's embedding so the next embed
   pass regenerates against the corrected NAICS titles. Sets
   `naics_critiqued_at` regardless of agreement so the same row isn't
   re-audited.

The 2026-05-25 backfill measured ~32% wrong tags from the old regex
`infer_capabilities` and ~41% Sonnet-vs-Haiku disagreement, so this
two-tier setup is a non-trivial accuracy lift over the previous path.

## Citations

Every breakdown row carries:

- `rfpPhrase` — the exact substring from RFP text / capabilities /
  deliverables that drove the score.
- `profileClaim` — the profile field value that matched it.
- `profileClaimSource` — where that claim came from (which contract,
  if any, evidenced it).

These render verbatim in `/matches/[rfpId]`:

> *"Strong specialty match: RFP says 'sidewalk and curb ramp
> installation'; your specialty 'concrete flatwork installation' from
> your 2023 Caltrans contract."*

## Match feedback

Good / bad thumbs on the detail page write to:

- `match_state.feedback_rating`, `feedback_reason`, `feedback_at`
- A snapshot of `match_score`, `match_tier`, `win_probability`,
  `incumbent_state` at the moment of feedback

The snapshot is essential — when the algorithm changes, raw scores
become meaningless, but the snapshot lets us answer "of all matches
we showed at 75+ that users thumbed down, what categories were
weak?"

See [Matching Fine-Tuning](Matching-Finetuning) for the planned
logistic-regression weight-learning system that will eventually
consume this feedback plus per-impression logs.
