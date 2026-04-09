# Backend Architecture

Civitas's backend is a set of **Next.js API routes** that handle authentication, contract management, profile storage, and LLM-powered document extraction. All user data is stored in **AWS S3** as JSON files. The backend runs as part of the same Next.js application as the frontend, deployed on **Vercel**.

## Tech Stack

| Technology | Purpose |
|---|---|
| Next.js 16.1 | API routes (serverless functions on Vercel) |
| jose 6.2 | JWT signing & verification (HS256) |
| bcryptjs 3.0 | Password hashing (12 rounds) |
| @aws-sdk/client-s3 3.x | AWS S3 client |
| Groq SDK 0.37 | LLM inference for metadata extraction |
| pdf-parse 2.4 | PDF text extraction (PDFParse v2 API) |
| mammoth 1.12 | DOCX text extraction |

## Directory Structure

```
front_end/src/
├── app/api/                           # API route handlers
│   ├── auth/
│   │   ├── login/route.ts             # POST — authenticate, return JWT
│   │   ├── signup/route.ts            # POST — create user, return JWT
│   │   ├── logout/route.ts            # POST — client-side token discard
│   │   ├── me/route.ts                # GET — current user (optional profile)
│   │   └── change-password/route.ts   # POST — change password
│   ├── contracts/
│   │   ├── route.ts                   # GET list, POST create (with extraction)
│   │   ├── [id]/route.ts              # GET, PATCH, DELETE single contract
│   │   └── extract/route.ts           # POST — extract metadata (no save)
│   ├── profile/
│   │   ├── route.ts                   # GET, PATCH profile
│   │   ├── extract/route.ts           # POST — multi-doc profile extraction
│   │   └── refresh/route.ts           # POST — recompute from contracts
│   ├── user/
│   │   ├── rfp-status/route.ts        # PATCH — track applied/in-progress RFPs
│   │   ├── generated-poe/route.ts     # GET — saved Plan of Execution
│   │   └── generated-proposal/route.ts # GET — saved Proposal
│   ├── events/route.ts                # GET — scraped RFP events from S3
│   ├── generate-proposal/route.ts     # POST — LLM proposal generation
│   ├── generate-plan-of-execution/route.ts
│   ├── match-summary/route.ts
│   ├── rfp-requirements-summary/route.ts
│   └── capabilities-analysis/route.ts
├── lib/                               # Shared server-side logic
│   ├── auth.ts                        # JWT signing/verification, password hashing
│   ├── s3.ts                          # S3 client (singleton, lazy-init)
│   ├── user-data.ts                   # User JSON CRUD with in-memory cache
│   ├── contract-storage.ts            # Contract CRUD operations
│   ├── profile-storage.ts             # Profile read/write/aggregate
│   ├── extraction.ts                  # LLM document extraction
│   ├── rfp-status.ts                  # RFP application tracking
│   └── rate-limit.ts                  # Rate limiting utility
└── proxy.ts                           # Edge proxy: rate limiting
```

## Security

### Authentication
- **Stateless JWT** (HS256) via the `jose` library
- JWT_SECRET must be set as an environment variable (server throws on missing/default)
- Token expiry: **7 days**
- Passwords hashed with **bcrypt (12 rounds)**
- Password requirements: 8+ chars, uppercase, lowercase, special character
- Legacy Django PBKDF2 hashes are transparently migrated to bcrypt on login

### Rate Limiting
Rate limiting is enforced at the edge via `proxy.ts` (Next.js proxy):
- **Auth endpoints** (`/api/auth/*`): 10 requests per minute per IP
- **Profile extraction** (`/api/profile/extract`): 5 requests per minute per IP
- Returns `429 Too Many Requests` with `Retry-After` header when exceeded

### Security Headers
All responses include:
- `Strict-Transport-Security` (HSTS, 2 years, includeSubDomains, preload)
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy` (restrictive: self + S3 + Groq API only)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` (camera, microphone, geolocation disabled)

### File Upload Validation
- Maximum file size: **25 MB**
- Allowed extensions: `.pdf`, `.docx`, `.doc`, `.txt`
- Maximum files per batch extraction: **10**
- Validation runs before any processing or S3 upload

## Storage Architecture

All data lives in **AWS S3** (`civitas-ai` bucket). No database.

```
S3 Bucket: civitas-ai/
├── users/{username}.json               # User data: auth, profile, contracts, RFP status
├── uploads/{user_id}/{contract_id}/    # Contract document files
└── scrapes/caleprocure/                # Scraped RFP data
    ├── all_events.json                 # All RFP events
    └── attachment_extractions.json     # Extracted attachment metadata
```

### User Data Caching
User JSON files are cached in-memory for **10 seconds** to avoid repeated S3 reads within the same request flow (a single API request may read user data 2-3 times for auth check, profile, and status).

## API Endpoints

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/signup/` | No | Create account, return JWT |
| POST | `/api/auth/login/` | No | Authenticate, return JWT |
| POST | `/api/auth/logout/` | Bearer | Client-side token discard |
| GET | `/api/auth/me/` | Bearer | Current user (`?include_profile=1` for full profile) |
| POST | `/api/auth/change-password/` | Bearer | Change password (requires current password) |

Auth responses include `Cache-Control: no-store` to prevent token caching.

### Contracts

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/contracts/` | Bearer | List all contracts (cached 30s) |
| POST | `/api/contracts/` | Bearer | Upload contract with optional extraction |
| GET | `/api/contracts/{id}/` | Bearer | Single contract details |
| PATCH | `/api/contracts/{id}/` | Bearer | Update metadata or file |
| DELETE | `/api/contracts/{id}/` | Bearer | Delete contract and S3 files |

### Profile

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/profile/` | Bearer | Fetch profile from S3 |
| PATCH | `/api/profile/` | Bearer | Update profile fields |
| POST | `/api/profile/refresh/` | Bearer | Recompute from all contracts |
| POST | `/api/profile/extract/` | No* | Multi-doc extraction for onboarding |

*Rate limited to 5 req/min per IP.

### RFP Status & Generation

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| PATCH | `/api/user/rfp-status/` | Bearer | Track applied/in-progress, save generated docs |
| GET | `/api/user/generated-poe/` | Bearer | Saved Plan of Execution (`?rfp_id=`) |
| GET | `/api/user/generated-proposal/` | Bearer | Saved Proposal (`?rfp_id=`) |
| GET | `/api/events/` | No | Scraped RFP events (S3-cached 5min, CDN-cached 5min) |

## LLM Document Extraction

Uses **Groq** (`llama-3.1-8b-instant`) to parse uploaded contracts into structured metadata.

### Supported Formats
- **PDF**: Text extracted via `pdf-parse` v2 (`PDFParse` class, `Uint8Array` input)
- **DOCX**: Text extracted via `mammoth`
- **TXT**: Read directly as UTF-8

### Pipeline
1. Validate file size (≤25 MB) and type (.pdf, .docx, .doc, .txt)
2. Extract raw text (capped at 50,000 characters)
3. Send to Groq with structured extraction prompt
4. Parse and normalize LLM JSON response
5. Return structured metadata or save as contract

## Environment Variables

```
JWT_SECRET=...                # Required. Strong random value for JWT signing.
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=civitas-ai
GROQ_API_KEY=...              # Required for document extraction and generation.
```

## Deployment

Deployed on **Vercel** at `civitas-mu.vercel.app`. All API routes run as serverless functions. Environment variables configured in Vercel dashboard.
