# RFP Matching Algorithm

## Overview

The matching algorithm evaluates how well a given RFP (Request for Proposal) aligns with a vendor/contractor's company profile. It produces a score (0–100), a tier label, and a detailed breakdown so users understand *why* an RFP is or isn't a good fit.

The algorithm runs entirely client-side using the shared library at `src/lib/rfp-matching.ts`, with an optional server-side LLM pass (via `/api/match-summary`) that rewrites the rule-based summary into natural language.

---

## Pipeline Stages

The algorithm follows a 4-stage pipeline:

```
Stage 1: Hard Disqualifiers  →  Stage 2: Token Expansion  →  Stage 3: Weighted Scoring  →  Stage 4: Tier Assignment
```

### Stage 1 — Hard Disqualifiers (Pass/Fail Gates)

Before any scoring happens, the algorithm checks for deal-breakers that make the RFP ineligible regardless of other alignment. If any disqualifier triggers, the RFP receives a score of **0** and a tier of **"disqualified"**.

| Check | Logic |
|-------|-------|
| **Deadline** | If the RFP deadline has already passed, the RFP is disqualified. |
| **Security Clearance** | Detects clearance requirements (Public Trust, Secret, Top Secret, TS/SCI) in the RFP text. If the profile does not hold an equal or higher clearance level, the RFP is disqualified. |
| **Set-Aside Status** | Detects small-business set-aside designations (8(a), HUBZone, SDVOSB, WOSB, SDB, MBE, etc.) in the RFP text. If the profile lacks the required status, the RFP is disqualified. |

### Stage 2 — Synonym Expansion

Before comparing tokens between the RFP and the profile, each token set is expanded using a domain synonym map (~30 categories covering IT, cybersecurity, construction, engineering, facilities, fleet, data/AI, and professional services).

**Example:** If the RFP mentions "AWS" and the profile lists "cloud computing," the synonym map expands "aws" → includes "cloud" and "cloud" → includes "aws", allowing them to match.

This bridges vocabulary gaps between how agencies write RFPs and how vendors describe their capabilities.

### Stage 3 — Weighted Scoring (100-Point Scale)

Each category contributes a weighted number of points to the total score:

| Category | Max Points | Method |
|----------|-----------|--------|
| **Capabilities** | 25 | Synonym-aware Jaccard similarity between RFP capabilities and profile capabilities, boosted by direct token overlap count. |
| **Industry** | 20 | Synonym-aware Jaccard similarity between RFP industry and profile industries. |
| **NAICS Codes** | 15 | Ratio of matching NAICS codes (supports prefix matching, e.g., 541 matches 541330). |
| **Certifications** | 12 | Ratio of RFP-required certifications found in the profile. |
| **Location** | 10 | Synonym-aware Jaccard similarity between RFP location and profile service areas (cities + counties). |
| **Agency Experience** | 8 | Synonym-aware Jaccard similarity between RFP agency and profile's agency experience list. |
| **Contract Type** | 5 | Jaccard similarity between RFP contract type and profile contract type preferences. |
| **Description Match** | 5 | Jaccard similarity between RFP title/description tokens and the full expanded profile keyword set. Only contributes if similarity exceeds 5%. |
| **Total** | **100** | |

**Scoring formula for similarity-based categories:**

```
points = maxPoints × (0.15 + 0.85 × clamp(similarity, 0, 1))
```

This ensures that any non-zero similarity earns at least 15% of the category's max points, while perfect overlap earns 100%.

#### Informational Indicators (Not Scored)

These factors appear in the breakdown for transparency but do not contribute to the numeric score:

- **Contract Scale** — Compares estimated RFP value against your company's past contract history. Flags if the RFP value exceeds past experience by 10x+.
- **Security Clearance** (when met) — Confirms your company holds the required clearance.
- **Set-Aside Eligibility** (when met) — Confirms your company qualifies for the set-aside.
- **Deadline Status** — Shows whether the deadline is open, TBD, or unparseable.

### Stage 4 — Tier Assignment

The final clamped score (0–100) maps to a tier:

| Score Range | Tier | Color in UI |
|-------------|------|-------------|
| 75–100 | Excellent | Green (Emerald) |
| 55–74 | Strong | Blue |
| 35–54 | Moderate | Amber |
| 0–34 | Low | Slate/Gray |
| N/A (disqualified) | Disqualified | Red |

---

## Key Algorithms

### Jaccard Similarity

Used for comparing token sets:

```
J(A, B) = |A ∩ B| / |A ∪ B|
```

Where A and B are sets of normalized, lowercased tokens (3+ characters, alphanumeric only).

### Synonym-Aware Jaccard

Before computing Jaccard similarity, both token sets are expanded through the synonym map. This means `{"aws"}` becomes `{"aws", "cloud", "amazon"}`, allowing matches that plain Jaccard would miss.

### NAICS Prefix Matching

NAICS codes are matched with prefix support. A profile code of `541` will match an RFP code of `541330` (and vice versa), since NAICS codes form a hierarchy where shorter prefixes represent broader categories.

---

## Data Flow

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  RFP Data   │────▶│  computeMatch()  │────▶│   RFPMatch      │
│  (parsed)   │     │  (rfp-matching)  │     │  {score, tier,  │
└─────────────┘     │                  │     │   breakdown,    │
                    │                  │     │   reasons, ...} │
┌─────────────┐     │                  │     └────────┬────────┘
│  Company    │────▶│                  │              │
│  Profile    │     └──────────────────┘              ▼
└─────────────┘                              ┌─────────────────┐
                                             │ /api/match-     │
                                             │ summary (Groq)  │
                                             │ → natural lang  │
                                             │   summary       │
                                             └─────────────────┘
```

1. The **dashboard** and **RFP detail page** both import `computeMatch()` from the shared library.
2. The rule-based match result is displayed immediately (score badge, tier, breakdown).
3. Optionally, the match data is sent to the `/api/match-summary` endpoint, which uses Groq (LLaMA 3.1 8B) to generate a natural-language summary explaining the match.

---

## Interfaces

### `CompanyProfile`

```typescript
interface CompanyProfile {
  companyName: string;
  industry: string[];
  sizeStatus: string[];
  certifications: string[];
  clearances: string[];
  naicsCodes: string[];
  workCities: string[];
  workCounties: string[];
  capabilities: string[];
  agencyExperience: string[];
  contractTypes: string[];
  contractCount?: number;
  totalPastContractValue?: string;
}
```

### `RFPMatch` (Output)

```typescript
interface RFPMatch {
  score: number;                    // 0–100
  tier: "excellent" | "strong" | "moderate" | "low" | "disqualified";
  disqualified: boolean;
  disqualifiers: string[];          // human-readable disqualifier messages
  reasons: string[];                // combined ✓/✗ reasons for display
  positiveReasons: string[];
  negativeReasons: string[];
  breakdown: ScoreBreakdown[];      // per-category detail
}
```

### `ScoreBreakdown`

```typescript
interface ScoreBreakdown {
  category: string;
  points: number;
  maxPoints: number;
  status: "strong" | "partial" | "weak" | "missing" | "neutral";
  detail: string;
}
```

---

## UI Integration

### Dashboard (`/dashboard`)

- **Match badge** on each RFP card shows tier-colored score
- **Disqualified RFPs** are dimmed (opacity-60) with a "Not Eligible" tag
- **Detail panel** (side panel) includes:
  - Disqualifier banner (red, if applicable)
  - Score breakdown with per-category progress bars
  - LLM-generated match summary

### RFP Detail Page (`/dashboard/rfp/[id]`)

- Header shows tier-colored match badge
- Disqualifier banner if ineligible
- Score breakdown section with progress bars
- LLM match analysis section

---

## Extending the Algorithm

### Adding a New Scoring Category

1. Define the max points (ensure total still sums to 100 or adjust existing weights).
2. Add the comparison logic in Stage 3 of `computeMatch()`.
3. Push a `ScoreBreakdown` entry to the `breakdown` array.
4. Add positive/negative reasons as appropriate.

### Adding New Synonyms

Add entries to the `SYNONYM_MAP` object in `rfp-matching.ts`. Each key maps to an array of related tokens. Synonyms are expanded bidirectionally — if you add `"aws": ["cloud"]`, also add `"cloud": ["aws"]` for full coverage.

### Adding New Disqualifiers

Add detection logic in Stage 1 of `computeMatch()`. Push to the `disqualifiers` array and return early with `score: 0, tier: "disqualified"`.
