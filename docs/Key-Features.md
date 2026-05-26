# Key Features

This page describes Civitas's major features and how they work end-to-end, from user interaction through to backend processing.

---

## 1. RFP Discovery & Search

### What It Does
Users browse a catalog of California government RFPs scraped from 57+ procurement portals (Cal eProcure, PlanetBids, BidSync, OpenGov). Each RFP is automatically scored against the user's company profile and ranked by relevance.

### How It Works

**Data Pipeline** (see [webscraping/v2/README.md](../webscraping/v2/README.md) for full details):
1. A Playwright-based scraper running on AWS Lambda (`webscraping/v2/scrapers/*.py`) hits each portal, fetches detail pages, and (where available) downloads PDF attachments inline.
2. Per-source manifests are written to `s3://civitas-ai/scrapes/v2/{source}/`.
3. PDF text is extracted via PyMuPDF and enriched by an LLM (Claude Haiku 4.5 by default; Groq as fallback) into structured requirements: NAICS codes, certifications, licenses, clearances, deliverables, evaluation criteria, incumbent vendor.
4. A post-scrape hook calls `/api/cron/sync-rfp-cache` to refresh the Postgres `rfp_cache` read view.

**Serving to Frontend:**
1. The Next.js API route (`/api/events`) reads from `rfp_cache` (or the S3 manifests directly, depending on the route), with the configured cache TTL.
2. Raw events are transformed into structured RFP objects with inferred fields:
   - **Location**: Extracted from title/description using regex and California city/county matching
   - **Industry**: Inferred via keyword pattern matching (22+ industry categories)
   - **Capabilities**: Extracted from description text (50+ capability types)
   - **Value**: Parsed from various formats ($1.5M, $100K-$500K, TBD)
3. LLM-extracted requirements are merged in where the source supports them (see [webscraping/v2/COVERAGE.md](../webscraping/v2/COVERAGE.md) for the per-source field matrix).

**Dashboard UI:**
- RFPs displayed as cards with match percentage, agency, deadline, and estimated value
- 12 filter categories allow precise searching
- Sort by match score (default), deadline, or estimated value
- Deferred rendering keeps the UI responsive during filter changes

---

## 2. AI-Powered Profile Building

### What It Does
Users can upload past contracts and proposals, and the system automatically extracts company metadata to build their profile, eliminating manual data entry.

### How It Works

**Upload Flow:**
1. User uploads one or more documents (PDF, DOCX, TXT) on the `/upload` or `/contracts` page
2. Files are sent to the Next.js API via `POST /api/profile/extract/` or `POST /api/contracts/`
3. For each document:
   - Text is extracted using `mupdf` (PDF) or `mammoth` (DOCX)
   - A PII redaction pass runs before any LLM call (see `lib/pii-redaction.ts`)
   - Text is sent through the provider-agnostic `lib/llm.ts` (defaults to Groq `llama-3.1-8b-instant`; configurable via `civitas.config.json`)
   - The LLM returns JSON with: contractor name, certifications, clearances, NAICS codes, work locations, capabilities, contract value, and more
4. Results from all documents are aggregated and deduplicated
5. The aggregated profile is returned to the frontend for user review (the v2 contracts flow surfaces a claims review screen — see [Architecture-v2 § 6.5](Architecture-v2.md))

**Profile Fields Extracted:**
- Company name
- Industry tags and NAICS codes
- Certifications (ISO 9001, CMMI, FedRAMP, etc.)
- Security clearances (Public Trust through TS/SCI)
- Work locations (cities and counties)
- Capabilities and technology stack
- Agency experience
- Contract types and total contract value

**Individual Contract Upload:**
Users can also upload contracts one at a time via `POST /api/contracts/`. Each contract is saved with its extracted metadata, and the overall profile is recomputed to reflect the new data.

---

## 3. RFP Matching Algorithm

### What It Does
Every RFP is scored from 0-100 against the user's profile, with a detailed breakdown showing exactly why the score is what it is. RFPs are classified into tiers: Excellent (80+), Strong (60-79), Moderate (40-59), or Low (<40).

### How It Works

The matching algorithm (`front_end/src/lib/rfp-matching.ts`) runs entirely client-side and uses a three-stage pipeline:

1. **Hard Disqualifiers** — Checks for required certifications, clearances, and set-aside types. If the profile doesn't meet a hard requirement, the RFP is marked as "Disqualified" with a score of 0.

2. **Synonym Expansion** — Profile and RFP terms are expanded using 50+ domain-specific synonym groups (e.g., "cloud" matches "AWS", "Azure", "SaaS"). This prevents false negatives from terminology differences.

3. **Weighted Scoring** — 10 categories are scored independently and combined:

| Category | Max Points | What's Compared |
|---|---|---|
| Capabilities | 25 | Profile services vs. RFP requirements |
| Industry | 15 | Profile industries vs. RFP industry |
| NAICS Codes | 10 | Code matching with prefix support |
| Certifications | 10 | Required certs vs. held certs |
| Clearances | 10 | Required level vs. held level (hierarchical) |
| Location | 10 | Work areas vs. RFP location (metro-aware) |
| Agency Experience | 5 | Past agency work vs. RFP agency |
| Contract Type | 5 | Contract type familiarity |
| Size Status | 5 | Business size classification match |
| Description | 5 | Free-text similarity (Jaccard) |

For a deeper dive, see the [Matching Algorithm](Matching-Algorithm) page.

---

## 4. AI Proposal Generation

### What It Does
Users can generate a complete proposal draft tailored to a specific RFP, using their company profile as context. Proposals can be iteratively refined with feedback.

### How It Works

1. User clicks "Generate Proposal" on an RFP detail page
2. Frontend sends the RFP data, company profile, and optional past proposals to `POST /api/generate-proposal`
3. The server-side API route constructs a prompt and calls the configured LLM (`lib/llm.ts`) with:
   - Full RFP details (requirements, deliverables, evaluation criteria)
   - Company profile (capabilities, certifications, experience)
   - Optional: text from past proposals for style matching (up to 80K characters)
4. The LLM generates a structured proposal with 5 sections:
   - Executive Summary
   - Understanding of Requirements
   - Approach & Methodology
   - Relevant Experience & Qualifications
   - Why Choose Us

**Style Matching:** If users provide past proposals, the LLM analyzes their writing style and mimics tone, vocabulary, and sentence structure in the generated proposal.

**Iterative Refinement:** Users can provide feedback (e.g., "emphasize our cloud experience more") and the system regenerates with those instructions.

**Persistence:** Generated proposals are saved to the user's S3 profile and can be retrieved later.

---

## 5. AI Plan of Execution

### What It Does
Generates an internal planning document to help users decide whether to pursue an RFP and prepare for it. Unlike proposals, these are candid assessments meant for internal use.

### How It Works

1. User clicks "Generate Plan" on an RFP detail page
2. Frontend sends data to `POST /api/generate-plan-of-execution`
3. The configured LLM generates a plan with 5 sections:
   - **Contract Requirements Summary** — Scope, deliverables, timeline, compliance needs
   - **Capability Gap Analysis** — What the company has vs. what the RFP requires
   - **Action Items** — Concrete steps to close gaps (hiring, certifications, partnerships), each with priority and timeline
   - **Execution Phases** — Kickoff, milestones, resource allocation if the bid wins
   - **Risks & Considerations** — Hard gaps, capacity issues, deadline pressure

The plan uses decisive language and is honest about gaps, making it a practical decision-making tool rather than a marketing document.

---

## 6. RFP Status Tracking

### What It Does
Users can track their progress on RFPs through three states: Saved, Applied, and In Progress. Status is persisted across sessions and devices.

### How It Works

**Status States:**
- **Saved** — Bookmarked for later review
- **Applied** — User has submitted an application
- **In Progress** — User is actively working on the RFP (plan/proposal generated)

**Backend Storage:**
Status is tracked via `PATCH /api/user/rfp-status/` (and the v2 `/api/match/{rfp_id}/` endpoint) and persisted in the Postgres `match_state` table, keyed by `(user_id, rfp_id)`.

The Home page (`/home`) displays quick stats and lists for each status category, with upcoming deadline alerts for the next 30 days.

---

## 7. Contract Management

### What It Does
Users maintain a portfolio of past contracts that feeds their profile. Contracts can be uploaded, edited, and deleted.

### How It Works

**Upload:** `POST /api/contracts/` with a file and optional metadata. The backend extracts text via `mupdf`/`mammoth`, runs PII redaction, calls the configured LLM for metadata extraction, saves the raw file to S3 (`uploads/{user_id}/{contract_id}/...`), and records the contract + extracted claims in Postgres.

**Auto-Extraction:** On upload, the LLM identifies:
- Issuing agency and contractor name
- Contract value and duration
- Required certifications and clearances
- NAICS codes and industry tags
- Work locations and scope

**Provenance:** Each extracted fact lands in the `claims` table with the source snippet, confidence score, and a `pending`/`accepted`/`rejected` status. Users review claims before they're applied to the profile (see [Architecture-v2 § 6.5](Architecture-v2.md)).

---

## 8. Web Scraping Pipeline

### What It Does
Automatically collects California government RFPs from 57+ procurement portals and enriches them with data extracted from PDF attachments. Full details in [webscraping/v2/README.md](../webscraping/v2/README.md) and the per-source field matrix in [webscraping/v2/COVERAGE.md](../webscraping/v2/COVERAGE.md).

### How It Works

**Stage 1: Scraping** (`webscraping/v2/scrapers/*.py`)
- Playwright + Chromium (containerized) in an AWS Lambda; EventBridge fires every 12 hours.
- Source-specific scrapers: `caleprocure.py`, `planetbids.py`, `bidsync.py`, `opengov.py`, `agentic.py`.
- Cal eProcure downloads PDFs inline via the session-bound href; PlanetBids gathers market intel (prospective bidders / bid results / awards) but most PDFs are gated; BidSync gives only search-result metadata; OpenGov hits the direct JSON API.
- Manifests are written per-source to `s3://civitas-ai/scrapes/v2/{source}/...`.

**Stage 2: Enrichment** (`webscraping/v2/pipeline/enrich.py`)
- Extracts text from downloaded PDFs via PyMuPDF.
- Sends text through the configured LLM (Claude Haiku 4.5 default with prompt caching on the system message; Groq fallback via `LLM_PROVIDER=groq`).
- Extracts structured requirements: NAICS codes, certifications, licenses, clearances, deliverables, evaluation criteria, key requirements, incumbent vendor and contract end date.
- SSRF protection blocks fetches to private IPs and metadata endpoints (see [Security & Optimization](Security.md)).

**Stage 3: Serving**
- A post-scrape hook calls `/api/cron/sync-rfp-cache` to refresh the Postgres `rfp_cache` and re-embed RFPs for semantic matching.
- The frontend `/api/events` and `/api/match` routes read from `rfp_cache`.
- Match scoring treats empty fields as **unknown, not zero** — important because PlanetBids `licenses_required: []` means "we don't know," not "no license required."

---

## 9. Authentication & Security

### What It Does
Secure user authentication with session cookies and Bearer tokens, supporting both browser-based and API access patterns.

### How It Works

**JWT Auth:**
- HS256 JWT signed via `jose`; secret loaded from `JWT_SECRET` env var (server throws on missing/default).
- Stored in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; never accessible to JS.
- Token expiry: 7 days (configurable via `auth.jwtExpiryDays` in `civitas.config.json`).

**Password Security:**
- Minimum 8 characters, at least one uppercase letter, one lowercase letter, one special character.
- Bcrypt with 12 rounds. Legacy Django PBKDF2 hashes are transparently re-hashed to bcrypt on first login.
- Validated on both frontend (real-time) and backend (server-side).

**Data Isolation:**
- User and profile rows live in Postgres, scoped by `user_id`; every query joins through `users(id)` so cross-user reads require explicit query bugs.
- Raw uploads live in S3 under `uploads/{user_id}/...` and are never publicly accessible.
- Auth is checked at the API route boundary before any DB or S3 read.

See [Security & Optimization](Security.md) for the full security control matrix.
