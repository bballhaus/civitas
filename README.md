# Civitas

Civitas reduces the time it takes small and medium government contractors to find compatible RFPs. It aggregates procurement opportunities from 62 California government sites into a single searchable dashboard with AI-powered matching.

## Architecture

| Component | Technology | Deployment |
|-----------|-----------|------------|
| Frontend + API | Next.js (App Router) | Vercel |
| Auth | bcrypt + JWT (stateless) | Vercel serverless |
| Storage | S3 (`civitas-ai` bucket) | AWS us-east-1 |
| LLM | Groq (llama-3.1-8b-instant) | API |
| Scraping | Playwright + Python | AWS Lambda (container) |
| Scheduling | EventBridge | Every 4 hours |

## Project Structure

```
civitas/
├── front_end/              # Next.js app (frontend + API routes)
│   ├── src/app/            # Pages and API routes
│   ├── src/lib/            # Shared libraries (auth, S3, extraction)
│   └── package.json
├── webscraping/            # RFP scraping system
│   └── v2/                 # Multi-source scraping pipeline
│       ├── scrapers/       # Site-specific scrapers (Cal eProcure, PlanetBids, BidSync)
│       ├── pipeline/       # Normalize + enrich pipeline
│       ├── orchestrator/   # CLI runner + site registry
│       └── deploy/         # Lambda, Dockerfile, EventBridge, CodeBuild
├── docs/                   # Project documentation
└── .github/workflows/      # CI/CD and manual scraping fallback
```

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
- `GROQ_API_KEY`, `JWT_SECRET`

### Scraping

```bash
pip install -r webscraping/v2/requirements.txt
playwright install chromium

# Run a specific site
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego --skip-upload

# List all sites
python -m webscraping.v2.orchestrator.runner --list
```

Environment variables loaded from `back_end/.env` automatically.

## Deployment

- **Frontend**: Push to `main` triggers Vercel deployment
- **Scraping**: `aws codebuild start-build --project-name civitas-scraper-build --source-version main` rebuilds the Lambda container
- **Schedule**: EventBridge rule `civitas-scrape-all` triggers Lambda every 4 hours
