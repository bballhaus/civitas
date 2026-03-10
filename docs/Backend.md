# Backend Architecture

Civitas's backend is a **Django 6** REST API that handles authentication, contract management, profile storage, and LLM-powered document extraction. All user data is stored in **AWS S3** as JSON files, with Django handling only authentication sessions.

## Tech Stack

| Technology | Purpose |
|---|---|
| Django 6.0.1 | Web framework |
| Django REST Framework 3.15.2 | API serialization & views |
| Boto3 1.34.0 | AWS S3 client |
| Groq SDK 0.10.0 | LLM inference for metadata extraction |
| pdfplumber 0.11.4 | PDF text extraction |
| python-docx 1.1.2 | DOCX text extraction |
| django-cors-headers | Cross-origin request handling |
| django-storages | S3 file storage backend |
| gunicorn 23.0.0 | Production WSGI server |

## Directory Structure

```
back_end/
├── civitas/                        # Django project configuration
│   ├── settings.py                 # App settings, CORS, auth, S3, LLM config
│   ├── urls.py                     # Root URL routing (/, /admin/, /api/)
│   └── wsgi.py                     # WSGI entry point
├── contracts/                      # Main application
│   ├── models.py                   # Contract & UserProfile models
│   ├── views.py                    # All API endpoint handlers
│   ├── urls.py                     # API URL routing
│   ├── serializers.py              # Request/response serialization
│   ├── auth.py                     # Bearer token authentication
│   ├── validators.py               # Custom password validators
│   ├── services/                   # Business logic layer
│   │   ├── aws_client.py           # Centralized Boto3 client
│   │   ├── contract_storage.py     # Contract CRUD in S3
│   │   ├── profile_storage.py      # Profile read/write/aggregate in S3
│   │   ├── extraction.py           # LLM document extraction
│   │   ├── token_storage.py        # Bearer token management
│   │   └── user_rfp_status.py      # RFP application tracking
│   └── migrations/
├── manage.py
└── requirements.txt
```

## Storage Architecture

Civitas uses a **S3-first** storage model. Django's database (SQLite in dev) only stores Django User objects and sessions. All application data lives in S3:

```
S3 Bucket: civitas-uploads/
├── users/{username}.json           # Profile, contracts, RFP status, tokens
├── uploads/{user_id}/{contract_id}/{filename}  # Contract document files
├── auth/tokens.json                # Bearer token → user_id index
└── scrapes/caleprocure/            # Scraped RFP data
    ├── all_events.json             # All RFP events
    └── attachment_extractions.json # Extracted attachment metadata
```

### User JSON Structure (`users/{username}.json`)

Each user has a single JSON file containing all their data:

```json
{
  "name": "Acme Corp",
  "certifications": ["ISO 9001", "CMMI Level 3"],
  "clearances": ["Secret"],
  "naics_codes": ["541511", "541512"],
  "industry_tags": ["IT Services"],
  "work_cities": ["Sacramento", "San Francisco"],
  "work_counties": ["Sacramento County"],
  "capabilities": ["Software Development", "Cloud Services"],
  "agency_experience": ["Caltrans", "DGS"],
  "contract_types": ["Fixed Price", "T&M"],
  "size_status": ["Small Business"],
  "contract_count": 5,
  "total_contract_value": "$2.5M",
  "uploaded_documents": [
    {
      "id": "uuid-here",
      "title": "Contract Title",
      "document": "uploads/user_id/contract_id/file.pdf",
      "created_at": "2025-01-15T...",
      "issuing_agency": "Caltrans",
      "features": { ... }
    }
  ],
  "applied_rfp_ids": ["evt-123", "evt-456"],
  "in_progress_rfp_ids": ["evt-789"],
  "generated_poe_by_rfp": { "evt-789": "Plan content..." },
  "generated_proposal_by_rfp": { "evt-789": "Proposal content..." }
}
```

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/auth/csrf/` | Fetch CSRF token for cross-origin POST requests |
| POST | `/api/auth/signup/` | Create new user account (username, email, password) |
| POST | `/api/auth/login/` | Authenticate and receive Bearer token |
| POST | `/api/auth/logout/` | Invalidate token and flush session |
| GET | `/api/auth/me/` | Get current user info (add `?include_profile=1` for full profile) |

**Dual Authentication**: The API supports both session-based auth (browser cookies) and Bearer token auth (`Authorization: Bearer <token>`). Bearer tokens are checked first; session auth is the fallback.

### Contracts

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/contracts/` | List all user contracts |
| POST | `/api/contracts/` | Upload contract with optional auto-extraction |
| GET | `/api/contracts/{id}/` | Get single contract details |
| PATCH | `/api/contracts/{id}/` | Update contract metadata |
| DELETE | `/api/contracts/{id}/` | Delete contract and its files |

When creating a contract with `extract=true` (default), the backend:
1. Extracts text from the uploaded file (PDF, DOCX, or TXT)
2. Sends text to Groq LLM for structured metadata extraction
3. Saves the contract with extracted metadata to S3
4. Recomputes the user's aggregated profile

### Profile

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/profile/` | Fetch user profile from S3 |
| PATCH | `/api/profile/` | Update profile fields |
| POST | `/api/profile/refresh/` | Recompute profile from all contracts |

### Extraction

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/contracts/extract/` | Extract metadata from a single file (no save) |
| POST | `/api/profile/extract/` | Extract and aggregate metadata from multiple files |

The profile extraction endpoint processes multiple documents and returns an aggregated company profile with deduplicated certifications, capabilities, NAICS codes, and locations.

### RFP Status

| Method | Endpoint | Description |
|---|---|---|
| PATCH | `/api/user/rfp-status/` | Update RFP status (applied, in-progress, save documents) |
| GET | `/api/user/generated-poe/` | Fetch saved Plan of Execution by `?rfp_id=` |
| GET | `/api/user/generated-proposal/` | Fetch saved Proposal by `?rfp_id=` |

**Supported actions** via the rfp-status endpoint:
- `mark_applied` / `remove_applied` — Track application status
- `mark_in_progress` / `remove_in_progress` — Track active work
- `save_generated_poe` — Save a generated Plan of Execution
- `save_generated_proposal` — Save a generated Proposal

## LLM Document Extraction

The extraction service (`contracts/services/extraction.py`) uses **Groq** (llama-3.1-8b-instant) to parse uploaded contracts into structured metadata.

### Supported Formats
- **PDF**: Text extracted via pdfplumber
- **DOCX**: Text extracted via python-docx
- **TXT**: Read directly

### Extraction Pipeline
1. Extract raw text from document (capped at 50,000 characters)
2. Send to Groq with a detailed prompt describing the expected JSON schema
3. Parse and normalize the LLM response
4. Return structured metadata

### Extracted Fields
- **Identity**: RFP ID, issuing agency, contractor name, title
- **Jurisdiction**: State, county, city
- **Dates**: Award date, start date, end date (ISO format)
- **Features**: Certifications, clearances, NAICS codes, industry tags, contract value, work description, technology stack, scope keywords, contract type

The extraction prompt specifically instructs the LLM to identify the contractor (company that won the contract) separately from the issuing agency, which is critical for building accurate company profiles.

## Authentication Details

### Signup Flow
1. Frontend sends username, email, password
2. Backend validates password (uppercase, lowercase, special char, 8+ chars)
3. Creates Django User
4. Generates Bearer token stored in S3
5. Creates empty S3 profile (`users/{username}.json`)
6. Returns user_id, username, token

### Login Flow
1. Frontend fetches CSRF token via `GET /api/auth/csrf/`
2. Submits credentials via `POST /api/auth/login/`
3. Django authenticates, creates session, generates Bearer token
4. Returns user_id, username, token

### Bearer Token Storage
Tokens are stored in `auth/tokens.json` in S3 as a mapping of `{token: user_id}`. The `BearerTokenAuthentication` class checks this index on every authenticated request.

## Profile Aggregation

When contracts are added or removed, the profile is recomputed:

1. Load all contracts from the user's `uploaded_documents`
2. Collect all certifications, clearances, NAICS codes, locations, etc.
3. Deduplicate and merge into the profile
4. Include technology_stack and scope_keywords as capabilities
5. Save updated profile to S3

This ensures the profile always reflects the full picture of the user's past contract experience.

## Configuration

### Key Settings (`civitas/settings.py`)

```python
# Authentication
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'contracts.auth.BearerTokenAuthentication',
        'rest_framework.authentication.SessionAuthentication',
    ]
}

# CORS (cross-origin from Next.js frontend)
CORS_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "https://civitas-ai.onrender.com",
]

# S3 Storage
AWS_STORAGE_BUCKET_NAME = "civitas-uploads"
AWS_S3_REGION_NAME = "us-east-1"

# LLM Extraction
EXTRACTION_LLM_PROVIDER = "groq"
EXTRACTION_LLM_MODEL = "llama-3.1-8b-instant"
EXTRACTION_MAX_TEXT_CHARS = 50000
```

### Environment Variables

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...           # Optional
AWS_STORAGE_BUCKET_NAME=civitas-uploads
GROQ_API_KEY=...
SECURE_COOKIES=true             # Set for HTTPS deployments
CSRF_TRUSTED_ORIGINS_EXTRA=...  # Additional trusted origins
```

## Development

```bash
cd back_end
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver       # Starts on localhost:8000
```

## Deployment

The backend is deployed on **Render.com** at `https://civitas-srv.onrender.com` using Gunicorn as the WSGI server. The database is SQLite (sufficient since only auth sessions are stored locally). All persistent data lives in S3.
