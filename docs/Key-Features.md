# Key Features

This page describes Civitas's major features and how they work end-to-end, from user interaction through to backend processing.

---

## 1. RFP Discovery & Search

### What It Does
Users browse a catalog of 1,000+ California government RFPs scraped from the Cal eProcurement portal. Each RFP is automatically scored against the user's company profile and ranked by relevance.

### How It Works

**Data Pipeline:**
1. A Selenium scraper (`webscraping/cal_eprocure_store.py`) navigates the Cal eProcurement site, extracting event metadata (title, agency, dates, description, attachments)
2. Scraped events are saved to S3 as `scrapes/caleprocure/all_events.json`
3. An attachment extraction script (`webscraping/extract_attachments.py`) processes downloaded PDFs with Groq LLM to extract structured requirements (NAICS codes, certifications, deliverables)
4. Extraction results are saved to `scrapes/caleprocure/attachment_extractions.json`

**Serving to Frontend:**
1. The Next.js API route (`/api/events`) loads both files from S3 (5-minute cache)
2. Raw events are transformed into structured RFP objects with inferred fields:
   - **Location**: Extracted from title/description using regex and California city/county matching
   - **Industry**: Inferred via keyword pattern matching (22+ industry categories)
   - **Capabilities**: Extracted from description text (50+ capability types)
   - **Value**: Parsed from various formats ($1.5M, $100K-$500K, TBD)
3. Attachment extraction data is merged in (NAICS codes, certifications, deliverables, evaluation criteria)

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
1. User uploads one or more documents (PDF, DOCX, TXT) on the `/upload` page
2. Files are sent to the Django backend via `POST /api/profile/extract/`
3. For each document:
   - Text is extracted using pdfplumber (PDF) or python-docx (DOCX)
   - Text is sent to Groq LLM (llama-3.1-8b-instant) with a structured extraction prompt
   - LLM returns JSON with: contractor name, certifications, clearances, NAICS codes, work locations, capabilities, contract value, and more
4. Results from all documents are aggregated and deduplicated
5. The aggregated profile is returned to the frontend for user review

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
3. The server-side API route constructs a prompt for Groq LLM including:
   - Full RFP details (requirements, deliverables, evaluation criteria)
   - Company profile (capabilities, certifications, experience)
   - Optional: text from past proposals for style matching (up to 80K characters)
4. Groq generates a structured proposal with 5 sections:
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
3. Groq LLM generates a plan with 5 sections:
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
- **Saved** — Bookmarked for later review (stored in frontend)
- **Applied** — User has submitted an application
- **In Progress** — User is actively working on the RFP (plan/proposal generated)

**Backend Storage:**
Status is tracked via `PATCH /api/user/rfp-status/` and stored in the user's S3 JSON:
```json
{
  "applied_rfp_ids": ["evt-123", "evt-456"],
  "in_progress_rfp_ids": ["evt-789"]
}
```

The Home page (`/home`) displays quick stats and lists for each status category, with upcoming deadline alerts for the next 30 days.

---

## 7. Contract Management

### What It Does
Users maintain a portfolio of past contracts that feeds their profile. Contracts can be uploaded, edited, and deleted.

### How It Works

**Upload:** `POST /api/contracts/` with a file and optional metadata. The backend extracts text, calls Groq for metadata extraction, saves the file to S3, and adds the contract to the user's profile.

**Auto-Extraction:** On upload, the LLM identifies:
- Issuing agency and contractor name
- Contract value and duration
- Required certifications and clearances
- NAICS codes and industry tags
- Work locations and scope

**Profile Sync:** After any contract change (create, update, delete), the user's aggregate profile is recomputed from all their contracts, keeping certifications, capabilities, and experience up to date.

---

## 8. Web Scraping Pipeline

### What It Does
Automatically collects California government RFPs from the Cal eProcurement portal and enriches them with data extracted from PDF attachments.

### How It Works

**Stage 1: Scraping** (`webscraping/cal_eprocure_store.py`)
- Uses Selenium to navigate the dynamically-rendered Cal eProcurement search page
- Extracts event metadata: title, department, dates, description, contact info
- Downloads attachment files (PDFs, docs)
- Uploads everything to S3

**Stage 2: Attachment Enrichment** (`webscraping/extract_attachments.py`)
- Reads downloaded PDF attachments
- Extracts text via pdfplumber
- Sends to Groq LLM to extract structured requirements:
  - NAICS codes, certifications, clearances
  - Contract value, duration, location details
  - Deliverables, evaluation criteria, key requirements
- Saves extraction results to `attachment_extractions.json`

**Stage 3: Serving**
- The frontend `/api/events` route merges base events with attachment extractions
- No frontend code changes needed when new data is scraped

The pipeline can be run independently of the main application, and new data is automatically picked up by the frontend's cached S3 reads.

---

## 9. Authentication & Security

### What It Does
Secure user authentication with session cookies and Bearer tokens, supporting both browser-based and API access patterns.

### How It Works

**Dual Auth System:**
- **Session Auth**: Django session cookies, used by the web frontend. CSRF protection for cross-origin POST requests.
- **Bearer Token Auth**: `Authorization: Bearer <token>` header, used for API access. Tokens stored in S3.

**Password Security:**
- Minimum 8 characters
- At least one uppercase letter, one lowercase letter, one special character
- Validated on both frontend (real-time) and backend (server-side)

**CORS Configuration:**
- Explicit allowed origins for localhost (dev) and Render.com (prod)
- Credentials included in cross-origin requests
- CSRF tokens required for state-changing operations

**Data Isolation:**
- Each user's data is stored in a separate S3 object
- Authentication is checked before any data access
- No cross-user data leakage possible through the API
