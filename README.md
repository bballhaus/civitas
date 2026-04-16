# Civitas

Civitas reduces the time it takes small and medium government contractors to find compatible RFPs. It aggregates procurement opportunities from 62 California government sites into a single searchable dashboard with AI-powered matching.

## Architecture

| Component | Technology | Deployment |
|-----------|-----------|------------|
| Frontend + API | Next.js 16 (App Router) | Vercel |
| Auth | bcrypt + JWT (HttpOnly cookies) | Vercel serverless |
| Storage | S3 (`civitas-ai` bucket, SSE-S3 encrypted, versioned) | AWS us-east-1 |
| Email | AWS SES (sandbox) | AWS us-east-1 |
| LLM | Groq (llama-3.1-8b-instant) | API |
| Scraping | Playwright + Python | AWS Lambda (container, non-root) |
| Scheduling | EventBridge | Every 4 hours |

## Project Structure

```
civitas/
├── front_end/              # Next.js app (frontend + API routes)
│   ├── src/app/            # Pages and API routes
│   ├── src/lib/            # Shared libraries (auth, S3, extraction, email)
│   ├── src/proxy.ts        # Edge proxy: nonce-based CSP + rate limiting
│   └── package.json
├── webscraping/            # RFP scraping system
│   └── v2/                 # Multi-source scraping pipeline
│       ├── scrapers/       # Site-specific scrapers (Cal eProcure, PlanetBids, BidSync)
│       ├── pipeline/       # Normalize + enrich pipeline (SSRF-protected)
│       ├── orchestrator/   # CLI runner + site registry
│       └── deploy/         # Lambda, Dockerfile, EventBridge, CodeBuild
├── docs/                   # Project documentation
└── .github/workflows/      # CI/CD and manual scraping fallback
```

## Security

| Control | Implementation |
|---------|---------------|
| Authentication | JWT in HttpOnly/Secure/SameSite=Strict cookies (24h expiry) |
| Password hashing | bcrypt (12 rounds) |
| CSP | Nonce-based script-src (no `unsafe-inline` or `unsafe-eval`) |
| Rate limiting | Sliding window: 5 req/15min on auth, 3/15min on password reset |
| File uploads | Extension + magic byte validation (PDF, DOCX, DOC, TXT) |
| Input validation | Regex-validated RFP IDs, sanitized S3 keys |
| LLM safety | System/user message separation (prompt injection mitigation) |
| SSRF protection | URL validation blocks private IPs, metadata endpoints |
| S3 security | Encryption at rest (SSE-S3), versioning, public access blocked, ETag optimistic locking |
| Credentials | Default AWS credential provider chain (no hardcoded keys) |
| Container | Non-root user in Lambda Docker image |
| Email verification | Token-based (auto-verified in dev mode) |
| Security logging | Structured JSON for all auth events |
| Security headers | HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, X-Permitted-Cross-Domain-Policies |

## Scraping Coverage

62 California procurement sites across 3 platforms:

- **PlanetBids** (43 agencies) -- cities including San Diego, Sacramento, Fresno, Anaheim, Riverside, and others
- **BidSync/Periscope** (15 agencies) -- counties and special districts including Orange County, Santa Clara County, LAUSD, SFMTA
- **Cal eProcure** (1) -- California state-level procurement
- **Agentic** (2) -- LA City and SF City via LLM-powered auto-discovery

See [webscraping/v2/README.md](webscraping/v2/README.md) for details on the scraping system.

## Local Development

### Frontend

```bash
cd front_end
npm install
npm run dev     # http://localhost:3000
```

Environment variables needed in `front_end/.env.local`:
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET`
- `GROQ_API_KEY`, `JWT_SECRET` (min 32 chars)
- `CIVITAS_FROM_EMAIL` (optional, SES-verified sender email for email features)

In development (`NODE_ENV=development`):
- Email verification is auto-approved (no SES needed)
- Password reset URLs are logged to console
- Cookies use `Secure=false` for localhost

### Email Setup (SES Sandbox)

```bash
# 1. Verify your sender email
aws ses verify-email-identity --email-address you@example.com --region us-east-1

# 2. Check your inbox and click the verification link

# 3. Set env var
CIVITAS_FROM_EMAIL=you@example.com

# Note: In sandbox mode, recipients must also be verified.
# Request production access via AWS console when ready for real users.
```

### Scraping

```bash
pip install -r webscraping/v2/requirements.txt
playwright install chromium

# Run a specific site
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego --skip-upload

# List all sites
python -m webscraping.v2.orchestrator.runner --list
```

## Deployment

- **Frontend**: Push to `main` triggers Vercel deployment
- **Scraping**: `aws codebuild start-build --project-name civitas-scraper-build --source-version main` rebuilds the Lambda container
- **Schedule**: EventBridge rule `civitas-scrape-all` triggers Lambda every 4 hours
