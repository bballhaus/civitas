# Backend Architecture

Civitas's backend runs entirely as **Next.js API routes** within the same Vercel deployment as the frontend. All user data is stored in **AWS S3** as JSON files. Authentication uses stateless **JWT tokens**.

> **Migration note (April 2025):** The backend was originally a separate Django REST API deployed on Render.com. It has been consolidated into Next.js API routes for a single Vercel deployment. The `back_end/` directory in the repo contains the legacy Django code for reference.

## Tech Stack

| Technology | Purpose |
|---|---|
| Next.js 16 API Routes | Server-side request handling |
| jose | JWT signing & verification (HS256) |
| bcryptjs | Password hashing (12 rounds) |
| @aws-sdk/client-s3 | AWS S3 client |
| Groq SDK | LLM inference for metadata extraction |
| pdf-parse | PDF text extraction |
| mammoth | DOCX text extraction |

## Directory Structure

```
front_end/src/
├── lib/                               # Shared backend libraries
│   ├── s3.ts                          # S3 client utility (get/put/delete)
│   ├── user-data.ts                   # User JSON read/write in S3
│   ├── auth.ts                        # JWT + password hashing + validation
│   ├── extraction.ts                  # LLM document extraction (PDF/DOCX/TXT)
│   ├── contract-storage.ts            # Contract CRUD operations
│   ├── profile-storage.ts             # Profile management + aggregation
│   └── rfp-status.ts                  # RFP status tracking + generated docs
├── app/api/                           # API route handlers
│   ├── auth/
│   │   ├── signup/route.ts            # POST — create account
│   │   ├── login/route.ts             # POST — authenticate
│   │   ├── logout/route.ts            # POST — logout (client-side token discard)
│   │   ├── me/route.ts                # GET — current user + profile
│   │   └── change-password/route.ts   # POST — change password
│   ├── contracts/
│   │   ├── route.ts                   # GET (list) / POST (create + upload)
│   │   ├── [id]/route.ts             # GET / PATCH / DELETE single contract
│   │   └── extract/route.ts           # POST — extract metadata from file
│   ├── profile/
│   │   ├── route.ts                   # GET / PATCH profile
│   │   ├── refresh/route.ts           # POST — recompute from contracts
│   │   └── extract/route.ts           # POST — extract profile from documents
│   ├── user/
│   │   ├── rfp-status/route.ts        # PATCH — update RFP status
│   │   ├── generated-poe/route.ts     # GET — saved Plan of Execution
│   │   └── generated-proposal/route.ts # GET — saved Proposal
│   ├── events/route.ts                # GET — fetch RFP events from S3
│   ├── capabilities-analysis/route.ts # POST — LLM capabilities analysis
│   ├── match-summary/route.ts         # POST — LLM match summary
│   ├── rfp-requirements-summary/route.ts # POST — LLM requirements summary
│   ├── generate-proposal/route.ts     # POST — LLM proposal generation
│   └── generate-plan-of-execution/route.ts # POST — LLM plan generation
```

## Storage Architecture

All application data lives in **AWS S3** as JSON files. There is no database.

```
S3 Bucket: civitas-ai/
├── users/{username}.json              # Profile, contracts, RFP status, password hash
├── uploads/{user_id}/{contract_id}/{filename}  # Contract document files
└── scrapes/caleprocure/               # Scraped RFP data
    ├── all_events.json                # All RFP events
    └── attachment_extractions.json    # Extracted attachment metadata
```

### User JSON Structure (`users/{username}.json`)

Each user has a single JSON file containing all their data:

```json
{
  "password_hash": "$2a$12$...",
  "email": "user@example.com",
  "profile": {
    "name": "Acme Corp",
    "certifications": ["ISO 9001"],
    "clearances": ["Secret"],
    "naics_codes": ["541511"],
    "industry_tags": ["IT Services"],
    "work_cities": ["Sacramento"],
    "work_counties": ["Sacramento County"],
    "capabilities": ["Software Development"],
    "agency_experience": ["Caltrans"],
    "size_status": ["Small Business"],
    "contract_count": 5,
    "total_contract_value": "2500000",
    "uploaded_documents": [{ "id": "...", "title": "...", "document": "..." }]
  },
  "applied_rfp_ids": ["evt-123"],
  "in_progress_rfp_ids": ["evt-789"],
  "generated_poe_by_rfp": { "evt-789": "Plan content..." },
  "generated_proposal_by_rfp": { "evt-789": "Proposal content..." }
}
```

## API Endpoints

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/signup` | Public | Create account (username, email, password) → JWT |
| POST | `/api/auth/login` | Public | Authenticate → JWT |
| POST | `/api/auth/logout` | Public | No-op (JWT is stateless; client discards token) |
| GET | `/api/auth/me` | Bearer | Current user info (`?include_profile=1` for full profile) |
| POST | `/api/auth/change-password` | Bearer | Change password |

**Authentication model:** Stateless JWT (HS256, 30-day expiry). Token is sent as `Authorization: Bearer <token>`. No session cookies, no CSRF tokens. The JWT is verified by signature alone — no S3 lookup required on each request.

### Contracts

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/contracts` | Bearer | List all user contracts |
| POST | `/api/contracts` | Bearer | Upload contract with optional auto-extraction |
| GET | `/api/contracts/{id}` | Bearer | Get single contract |
| PATCH | `/api/contracts/{id}` | Bearer | Update contract metadata |
| DELETE | `/api/contracts/{id}` | Bearer | Delete contract and S3 files |
| POST | `/api/contracts/extract` | Bearer | Extract metadata from file (no save) |

### Profile

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/profile` | Bearer | Fetch profile from S3 |
| PATCH | `/api/profile` | Bearer | Update profile fields |
| POST | `/api/profile/refresh` | Bearer | Recompute profile from all contracts |
| POST | `/api/profile/extract` | Public | Extract profile from multiple uploaded files |

### RFP Status & Generated Documents

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| PATCH | `/api/user/rfp-status` | Bearer | Update RFP status (applied/in-progress/save docs) |
| GET | `/api/user/generated-poe` | Bearer | Fetch saved Plan of Execution (`?rfp_id=`) |
| GET | `/api/user/generated-proposal` | Bearer | Fetch saved Proposal (`?rfp_id=`) |

### LLM-Powered Features

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/events` | Fetch and enrich RFP events from S3 |
| POST | `/api/capabilities-analysis` | LLM analysis of profile vs RFP |
| POST | `/api/match-summary` | LLM summary of match quality |
| POST | `/api/rfp-requirements-summary` | LLM summary of RFP requirements |
| POST | `/api/generate-proposal` | LLM proposal generation (with style matching) |
| POST | `/api/generate-plan-of-execution` | LLM execution plan generation |

## LLM Document Extraction

The extraction service (`lib/extraction.ts`) uses **Groq** (llama-3.1-8b-instant) to parse uploaded contracts into structured metadata.

### Supported Formats
- **PDF**: Text extracted via pdf-parse
- **DOCX**: Text extracted via mammoth
- **TXT**: Read directly as UTF-8

### Extraction Pipeline
1. Extract raw text from document (capped at 50,000 characters)
2. Send to Groq with a detailed prompt describing the expected JSON schema
3. Parse and normalize the LLM response
4. Return structured metadata

### Extracted Fields
- **Identity**: RFP ID, issuing agency, contractor name, title
- **Jurisdiction**: State, county, city (with California geography inference)
- **Dates**: Award date, start date, end date (ISO format)
- **Features**: Certifications, clearances, NAICS codes, industry tags, contract value, work description, technology stack, scope keywords, contract type, size/status

## Authentication Details

### Signup Flow
1. Frontend sends `POST /api/auth/signup` with username, email, password
2. Server validates password (8+ chars, uppercase, lowercase, special char)
3. Checks username uniqueness in S3
4. Hashes password with bcrypt (12 rounds)
5. Creates `users/{username}.json` in S3
6. Creates default empty profile
7. Signs and returns JWT (30-day expiry)

### Login Flow
1. Frontend sends `POST /api/auth/login` with username, password
2. Server loads `users/{username}.json` from S3
3. Verifies bcrypt password hash
4. Signs and returns JWT
5. (For migrated Django users: also checks PBKDF2 hash, re-hashes to bcrypt on success)

### Password Storage
- **New users**: bcrypt hash in `password_hash` field
- **Migrated users**: Django PBKDF2 hash in `password_hash_legacy` field (transparently re-hashed to bcrypt on first login)

## Profile Aggregation

When contracts are added or removed, `refreshProfileFromContracts()` recomputes the profile:

1. Load all contracts from the user's `uploaded_documents`
2. Collect all certifications, clearances, NAICS codes, locations, etc.
3. Reclassify size/status designations found in certifications
4. Include technology_stack and scope_keywords as capabilities
5. Auto-set company name from contractor names if empty
6. Deduplicate and save updated profile to S3

## Environment Variables

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=civitas-ai
GROQ_API_KEY=...
JWT_SECRET=...                    # HS256 signing key (min 256 bits)
```

## Development

```bash
cd front_end
npm install
npm run dev          # Starts on localhost:3000
```

All API routes run as Next.js server-side functions — no separate backend process needed.

## Deployment

The entire application (frontend + backend API routes) is deployed as a single **Vercel** project at `civitas-mu.vercel.app`. Environment variables are set in the Vercel dashboard. Vercel auto-deploys on push to `main`.
