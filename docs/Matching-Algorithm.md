# Matching Algorithm

The matching algorithm is the core intelligence of Civitas. It scores every RFP against a user's company profile, producing a 0-100 relevance score with a detailed breakdown explaining exactly why the score is what it is.

**Source:** `front_end/src/lib/rfp-matching.ts` (1,300+ lines)
**Execution:** Runs entirely client-side in the browser
**Output:** Score (0-100), tier classification, per-category breakdown, and human-readable explanations

> **Note on LLM usage:** The matching algorithm itself does **not** use LLMs. All scoring is done with deterministic methods (regex, Jaccard similarity, synonym lookup, canonicalization). LLMs are used in two *separate* parts of the system:
> - **Profile capabilities** are extracted from uploaded contracts via Groq LLM at upload time, before matching ever runs.
> - **RFP capabilities** are inferred using ~90 regex patterns against the RFP title and description (`inferCapabilities()` in `/api/events/route.ts`). LLM-extracted capabilities from attachments are explicitly **not** used as the primary source because extraction quality was too inconsistent (e.g., tagging towing RFPs as "Cloud Services").
>
> There is also a separate `/api/capabilities-analysis` endpoint that uses Groq to generate a natural-language summary of how a user's capabilities compare to an RFP — but this is for display on the RFP detail page, not part of the scoring pipeline.

---

## Pipeline Overview

The algorithm uses a **three-stage pipeline**:

```
RFP + Profile
     │
     ▼
┌─────────────────────┐
│  Stage 1: Hard       │  ──→  Disqualified (score = 0)
│  Disqualifiers       │       if required certs/clearances missing
└─────────────────────┘
     │ pass
     ▼
┌─────────────────────┐
│  Stage 2: Synonym    │  Expand all text fields with domain synonyms
│  Expansion           │  to prevent false negatives
└─────────────────────┘
     │
     ▼
┌─────────────────────┐
│  Stage 3: Weighted   │  Score 10 categories independently
│  Scoring             │  Normalize to 0-100
└─────────────────────┘
     │
     ▼
  Score + Tier + Breakdown + Explanations
```

---

## Stage 1: Hard Disqualifiers

Before scoring, the algorithm checks for deal-breakers. If any check fails, the RFP is immediately marked as **Disqualified** with a score of 0.

### Required Certifications
If the RFP lists required certifications, the profile must hold **all** of them. Both sides are canonicalized first (see Canonicalization section below), so "ISO 9001", "ISO-9001", and "iso9001:2015" are all treated as equivalent.

If the RFP has no certification requirements, this check is skipped.

### Required Clearances
Security clearances follow a hierarchy:

```
Public Trust < Secret < Top Secret < TS/SCI
```

If the RFP requires a clearance level, the profile must hold that level **or higher**. For example, a Top Secret clearance satisfies a Secret requirement.

### Set-Aside Types
If the RFP specifies set-aside types (8(a), HUBZone, DVBE, etc.), the profile must match at least one. Both sides are canonicalized to handle variant spellings.

---

## Stage 2: Synonym Expansion

To prevent false negatives from terminology differences, both profile and RFP text fields are expanded using domain-specific synonym groups before scoring.

### Synonym Groups

The algorithm maintains 50+ synonym groups covering major sectors:

| Domain | Example Synonyms |
|---|---|
| Cloud/IT | cloud, aws, azure, gcp, saas, iaas, paas |
| Construction | construction, building, demolition, renovation |
| HVAC | hvac, heating, ventilation, cooling, air conditioning |
| Security | cybersecurity, infosec, information security, network security |
| Data | data analytics, data science, big data, machine learning |
| Web | web development, frontend, backend, full stack |
| Medical | healthcare, medical, clinical, health services |

### How Expansion Works

1. Text is tokenized (split into words, normalized to lowercase)
2. Each token is looked up in the synonym map
3. If found, all synonyms in that group are added to the token set
4. Expanded token sets are used for comparison

**Example:** Profile has "cloud services". RFP requires "AWS migration support".
- "cloud" expands to include "aws", "azure", "gcp", "saas"
- "aws" in the RFP matches the expanded profile tokens
- Result: Partial match detected instead of zero overlap

### Stop Expansion

Generic terms like "development", "management", "services", and "support" are **not** expanded to avoid false positives where unrelated capabilities appear to match.

### Performance

Synonym lookups are memoized in a cache (max 500 entries) to avoid repeated computation across the ~1,000 RFPs being scored.

---

## Stage 3: Weighted Scoring

Ten categories are scored independently, each with a maximum point allocation. The final score is the sum of earned points normalized to a 0-100 scale.

### Category Breakdown

#### 1. Capabilities Match (25 points)

The highest-weighted category. Compares the user's service capabilities against what the RFP requires.

**Method:** Synonym-aware Jaccard similarity
- Profile capabilities and RFP capabilities are tokenized and expanded with synonyms
- Jaccard similarity = |intersection| / |union|
- Points = 25 * similarity

**Status thresholds:**
- Strong: similarity >= 0.8
- Partial: similarity >= 0.5
- Weak: similarity >= 0.2
- Missing: similarity < 0.2

#### 2. Industry Match (15 points)

Checks whether the user operates in the same industry as the RFP.

**Method:** Exact match or synonym expansion
- If the profile's industries include the RFP's industry (or a synonym), full points
- Partial credit for related industries

#### 3. NAICS Code Match (10 points)

Compares NAICS codes between profile and RFP.

**Method:** Prefix matching with a minimum of 4 digits
- Exact 6-digit match: full credit
- 4-5 digit prefix match: partial credit (same subsector)
- Example: Profile "541511" matches RFP "5415" (Computer Systems Design)

#### 4. Certifications Match (10 points)

Compares certifications the RFP requires against those the profile holds.

**Method:** Canonical matching (see Canonicalization section)
- Points = (matched certifications / total required) * 10
- All variants of a certification are treated as equivalent

#### 5. Clearances Match (10 points)

Compares security clearance levels.

**Method:** Hierarchical comparison
- Profile clearance >= RFP requirement: full points
- Profile clearance < RFP requirement: zero points
- No clearance required: full points (neutral)

#### 6. Location Proximity (10 points)

Evaluates geographic alignment between the user's work areas and the RFP's location.

**Scoring tiers:**
| Match Type | Score |
|---|---|
| Exact city or county match | 1.0 (10 pts) |
| Same metro area | 0.75 (7.5 pts) |
| Both in California | 0.2 (2 pts) |
| No match | 0.0 (0 pts) |

**Metro Area Groups:**
The algorithm recognizes California metro clusters:
- **Bay Area**: San Francisco, Oakland, San Jose, Fremont, Santa Clara, etc.
- **Greater LA**: Los Angeles, Long Beach, Pasadena, Glendale, etc.
- **Sacramento Metro**: Sacramento, Elk Grove, Roseville, Folsom, etc.
- **San Diego Area**: San Diego, Chula Vista, Oceanside, Carlsbad, etc.
- **Inland Empire**: Riverside, San Bernardino, Ontario, Rancho Cucamonga, etc.

#### 7. Agency Experience (5 points)

Checks if the user has previously worked with the RFP's issuing agency.

**Method:** Token matching with alias expansion

The algorithm maps agency abbreviations and alternative names:
- "Caltrans" = "Department of Transportation" = "CA Dept of Transportation"
- "DGS" = "Department of General Services"
- "CDCR" = "Department of Corrections and Rehabilitation"

#### 8. Contract Type Match (5 points)

Compares the RFP's contract type against the user's experience.

**Method:** Canonical matching
- Types: Fixed Price, Time & Materials, IDIQ, Competitive Bid, Sole Source, etc.
- Abbreviations normalized (T&M = Time and Materials)

#### 9. Size Status Match (5 points)

Compares business size classifications.

**Method:** Set intersection
- Classifications: Small Business, 8(a), DVBE, HUBZone, WOSB, SDVOSB, etc.
- Match if any profile classification matches any RFP set-aside

#### 10. Description Match (5 points)

Free-text comparison between profile capabilities/experience and RFP description.

**Method:** Jaccard similarity on tokenized text
- Stop words filtered (150+ generic terms removed)
- Low weight because descriptions are long and noisy
- Acts as a catch-all for relevant terms not captured in structured fields

---

## Tier Classification

After scoring, the raw 0-100 score is classified into a tier:

| Tier | Score Range | Meaning |
|---|---|---|
| Excellent | 80-100 | Strong alignment across most categories |
| Strong | 60-79 | Good fit with some gaps |
| Moderate | 40-59 | Partial alignment, notable gaps |
| Low | 0-39 | Weak fit |
| Disqualified | N/A | Failed a hard requirement |

---

## Canonicalization

A major challenge in matching is that the same concept can be expressed many different ways. The algorithm uses canonicalization maps to normalize variants.

### Certification Canonicalization

~80 variants mapped to canonical forms:

| Variants | Canonical |
|---|---|
| "iso 9001", "ISO-9001", "iso9001", "iso 9001:2015" | `iso_9001` |
| "small business", "sb", "Small Business (SB)", "california certified small business" | `sb` |
| "dvbe", "disabled veteran business enterprise", "DVBE" | `dvbe` |
| "fedramp", "fed-ramp", "fed ramp", "FedRAMP" | `fedramp` |
| "cmmi", "cmmi level 3", "CMMI-DEV" | `cmmi` |

### Set-Aside Canonicalization

~30 variants for business set-aside classifications.

### Contract Type Canonicalization

~20 variants for contract delivery methods (Fixed Price, T&M, IDIQ, etc.).

---

## Text Processing

### Normalization

All text goes through a normalization pipeline before comparison:

1. Convert to lowercase and trim whitespace
2. Replace compound terms with underscored versions:
   - "C++" → "c_plus_plus"
   - ".NET" → "dot_net"
   - "AI/ML" → "ai_ml"
   - "T&M" → "t_and_m"
3. Strip punctuation (except underscores)
4. Collapse multiple spaces

### Tokenization

Normalized text is split into tokens:
- Minimum 2 characters per token
- Short domain terms preserved: "AI", "IT", "ML", "QA", "UX", "5G"
- Used for Jaccard similarity and synonym expansion

### Contract Value Parsing

Handles multiple formats:
- "$1.5M", "$1,500,000", "1500K"
- Ranges: "$5-10M", "$5M-$10M", "$100K - $500K" (takes the maximum)
- Unknown: Falls back to "TBD"

---

## Explanation Generation

The algorithm generates human-readable explanations for each match:

**Summary bullets** (1-3 per RFP):
- "Strong capability match (9 of 12 required services)"
- "Located in your Bay Area work region"
- "Missing certifications: FedRAMP, NIST 800-53"
- "Past experience with this agency (Caltrans)"

**Detailed breakdown:**
Each scoring category includes `matchedTokens`, `rfpTokens`, and `profileTokens` arrays, allowing the UI to show exactly which terms matched and which didn't.

---

## Performance Characteristics

- **Scoring ~1,000 RFPs**: Runs in under 1 second on modern hardware
- **Synonym cache**: 500-entry LRU cache for expanded token lookups
- **Token expansion cache**: 200-entry cache for repeated term expansion
- **No network calls**: All scoring is client-side; no API latency
- **Incremental filtering**: React deferred rendering keeps the UI responsive during filter changes

---

## Data Flow

```
User Profile (from S3)          RFP Catalog (from S3)
        │                              │
        ▼                              ▼
  Normalize & Tokenize          Normalize & Tokenize
        │                              │
        └──────────┬───────────────────┘
                   │
                   ▼
          Hard Disqualifier Check
                   │
            pass   │   fail → Disqualified
                   ▼
          Synonym Expansion
                   │
                   ▼
          Score 10 Categories
                   │
                   ▼
          Normalize to 0-100
                   │
                   ▼
          Classify Tier
                   │
                   ▼
          Generate Explanations
                   │
                   ▼
     { score, tier, breakdown, reasons }
```
