# Civitas RFP Scraping System v2

## Overview

The v2 scraping system collects RFPs (Requests for Proposals) from California government procurement sites. It replaces the original single-site Selenium scraper with a multi-source, multi-tier architecture that supports 33+ procurement sites across the state.

## Architecture

```
EventBridge (schedule)  →  Lambda (container)  →  Scraper  →  Pipeline  →  S3  →  Frontend API
                                   │
                            self-invokes for
                            next batch (chained)
```

### Three Scraper Tiers

| Tier | Type | Technology | When to Use | LLM Cost |
|------|------|-----------|-------------|----------|
| 1 | **API** | `httpx` / `aiohttp` | Site has an API or structured endpoints (BidSync) | None |
| 2 | **Structured** | Playwright | Known site with stable selectors (Cal eProcure, PlanetBids) | None |
| 3 | **Agentic** | Playwright + Claude Sonnet | Unknown site or when structured scrapers break | Only on first run; cached after |

### Verified & Live Sites

| Source | Events in S3 | Scraper Tier | Status |
|--------|-------------|--------------|--------|
| **Cal eProcure** | ~625 | Structured | Tested locally. Blocked from AWS IPs (needs proxy or GitHub Actions). |
| **San Diego (PlanetBids)** | 30 | Structured | Live in S3. Portal ID: 17950. |

### Registered Sites (not yet scraped)

- **BidSync/Periscope** (~15 agencies) — Buyer IDs are placeholders, need verification against live site (BidSync has migrated to periscopeholdings.com SPA)
- **PlanetBids** — San Diego verified (portal 17950). Other portal IDs need discovery. Many CA cities (Sacramento, Oakland, etc.) redirect to PlanetBids.
- **Agentic targets** (5 sites) — City of LA, San Francisco, San Diego, Sacramento, Oakland

### Key Discovery

Many California cities don't host bids directly — they redirect to **PlanetBids/VendorLine**. The agentic scraper is useful for discovering which platform each city uses and what their portal ID is. For example, San Diego's procurement page redirects to `vendors.planetbids.com/portal/17950/bo/bo-search`.

## Project Structure

```
webscraping/v2/
├── __init__.py
├── config.py                 # AWS/LLM credentials from environment
├── models.py                 # Pydantic schemas (data contracts)
├── utils.py                  # Shared utilities (hashing, ID generation)
├── requirements.txt
├── README.md
├── scrapers/
│   ├── base.py               # BaseScraper ABC (throttling, S3 upload, dedup)
│   ├── caleprocure.py        # Cal eProcure (Playwright, structured)
│   ├── bidsync.py            # BidSync API scraper (covers ~15 agencies)
│   ├── planetbids.py         # PlanetBids (Playwright, structured)
│   └── agentic.py            # LLM-powered auto-adaptation scraper
├── pipeline/
│   ├── normalize.py          # Industry/location/capability inference
│   └── enrich.py             # PDF text extraction + Groq LLM enrichment
├── orchestrator/
│   └── runner.py             # CLI entry point, site registry, pipeline orchestration
└── deploy/
    ├── Dockerfile            # Lambda container image (Playwright + Chromium)
    ├── lambda_handler.py     # Lambda entry point with chained batch support
    ├── template.yaml         # SAM template (Lambda + EventBridge)
    ├── buildspec.yml         # CodeBuild spec for building Docker image
    ├── aws-setup.sh          # One-command AWS infrastructure setup
    └── deploy.sh             # Docker-based deploy (requires Docker locally)
```

## Data Flow

1. **Scrape**: Each scraper produces `RawScrapedEvent` objects (source-agnostic schema)
2. **Enrich** (optional): PDFs are downloaded, text extracted with `pdfplumber`, and sent to Groq LLM for structured metadata (NAICS codes, certifications, clearances, etc.)
3. **Normalize**: Raw events + enrichment data are transformed into `EnrichedEvent` objects with inferred industry, location, and capabilities
4. **Merge**: New events are merged with existing S3 data — events no longer on the source site are marked `closed` instead of deleted
5. **Upload**: Merged events are written to S3 as per-source manifests at `scrapes/v2/manifests/{source_id}/latest.json`
6. **Frontend**: The Next.js API route (`/api/events`) reads all manifests, filters out closed events, merges with legacy data, deduplicates, and serves to the dashboard

## Event Persistence

Events are never deleted. On each scrape:
- **Still present** on source site → status stays `open`, `last_seen_at` updated
- **No longer present** → status set to `closed`, `closed_at` timestamp recorded
- **Brand new** → added with status `open`, `first_seen_at` set

The legacy `all_events.json` format only includes open events for backward compatibility.

## Data Models

### RawScrapedEvent (scraper output)
- `source_id`, `source_event_id`, `source_url`
- `title`, `description`, `issuing_agency`
- `posted_date`, `due_date`
- `contact` (name, email, phone)
- `procurement_type`, `attachment_urls`
- `raw_metadata` (source-specific extras)

### EnrichedEvent (pipeline output, frontend-ready)
All fields from `RawScrapedEvent` plus:
- `status` (`open` / `closed`), `first_seen_at`, `last_seen_at`, `closed_at`
- `industry`, `capabilities`, `certifications` (inferred)
- `location` (extracted from text or attachment data)
- `estimated_value`, `naics_codes`
- `clearances_required`, `set_aside_types`, `deliverables`
- `contract_duration`, `evaluation_criteria`
- `attachment_rollup` (summary + processed PDFs list)

## S3 Layout

```
civitas-ai/
  scrapes/
    v2/
      manifests/{source_id}/latest.json    # Per-source event index (EnrichedEvent[])
      events/{source_id}/{event_hash}.json # Individual raw events
      recipes/{source_id}.json             # Cached agentic scraper recipes
    caleprocure/                           # Legacy format (backward compat)
      all_events.json
      attachment_extractions.json
```

## Usage

### Setup

```bash
# Install dependencies
pip install -r webscraping/v2/requirements.txt
playwright install chromium

# Set environment variables (or add to back_end/.env)
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_STORAGE_BUCKET_NAME=civitas-ai
export GROQ_API_KEY=...           # for PDF enrichment
export ANTHROPIC_API_KEY=...      # for agentic scraper only
```

### Running locally

```bash
# List all registered sites
python -m webscraping.v2.orchestrator.runner --list

# Run a specific site
python -m webscraping.v2.orchestrator.runner --site caleprocure

# Run without PDF enrichment (faster, no Groq API needed)
python -m webscraping.v2.orchestrator.runner --site caleprocure --skip-enrich

# Run without uploading to S3 (local testing)
python -m webscraping.v2.orchestrator.runner --site caleprocure --skip-upload

# Run all enabled sites
python -m webscraping.v2.orchestrator.runner

# Verbose logging
python -m webscraping.v2.orchestrator.runner --site caleprocure -v
```

### Testing individual scrapers

```bash
# Cal eProcure
python -m webscraping.v2.scrapers.caleprocure

# PlanetBids (San Diego)
python -m webscraping.v2.scrapers.planetbids

# Agentic scraper on a custom URL
python -m webscraping.v2.scrapers.agentic https://www.lacity.org/for-businesses/bids-contracts la_city
```

## AWS Deployment

### What's deployed

| Resource | Name | Purpose |
|----------|------|---------|
| ECR | `civitas-scraper` | Container image registry |
| Lambda | `civitas-rfp-scraper` | Runs scraping pipeline (container-based) |
| EventBridge | `civitas-scrape-caleprocure` | Triggers Lambda every 4 hours |
| CodeBuild | `civitas-scraper-build` | Builds Docker image remotely |
| IAM | `civitas-scraper-lambda-role` | Lambda execution (S3 + self-invoke) |
| IAM | `civitas-scraper-codebuild-role` | CodeBuild (ECR + Lambda update) |

### Chained Lambda invocations

Cal eProcure has ~625 events, each taking ~1 min to scrape. Lambda's 15-min timeout means one invocation can only scrape ~12 events. The system handles this by **chaining**:

1. Lambda scrapes a batch of 40 events
2. Saves progress to S3 (merged with existing data)
3. Async-invokes itself with the next batch offset
4. Repeats until all events are scraped (~16 invocations, ~3 hours total)

### Deploying code changes

```bash
# Rebuild image via CodeBuild (no Docker needed locally)
aws codebuild start-build --project-name civitas-scraper-build --source-version webscraping

# Update Lambda with new image
aws lambda update-function-code \
    --function-name civitas-rfp-scraper \
    --image-uri 681816819209.dkr.ecr.us-east-1.amazonaws.com/civitas-scraper:latest

# Invoke manually
aws lambda invoke \
    --function-name civitas-rfp-scraper \
    --cli-binary-format raw-in-base64-out \
    --payload '{"site_id":"caleprocure","batch_offset":0,"batch_size":40}' \
    --invocation-type Event \
    /tmp/response.json

# Check logs
aws logs tail /aws/lambda/civitas-rfp-scraper --follow --region us-east-1
```

### Full infrastructure setup (first time)

```bash
bash webscraping/v2/deploy/aws-setup.sh
```

### Known issue: Cal eProcure blocks AWS IPs

Cal eProcure returns 403/empty results when accessed from AWS datacenter IPs. The scraper works fine from residential IPs (local machine). Options to resolve:
1. Add a residential proxy service (Bright Data, ScraperAPI)
2. Use GitHub Actions (`.github/workflows/scrape.yml` is ready, needs secrets configured)
3. Run locally via cron

## The Agentic Scraper

The agentic scraper allows adding new procurement sites without writing site-specific code.

### How it works

1. **Discovery**: Claude Sonnet navigates the site to find the RFP listing page (looks for "Current Bids", "Open Solicitations", etc.)
2. **Recipe generation**: The agent analyzes the page HTML and generates a JSON "recipe" — CSS selectors for the listing container, individual fields (title, due date, agency, detail URL), and pagination controls
3. **Recipe caching**: The recipe is saved to S3 so subsequent runs use it directly with zero LLM cost
4. **Self-healing**: If a cached recipe returns zero results (e.g., the site changed its layout), the agent automatically re-discovers and generates a new recipe

### Stealth measures

All Playwright-based scrapers include anti-detection:
- `--disable-blink-features=AutomationControlled`
- `navigator.webdriver` property hidden
- Realistic user-agent, locale, timezone
- `--disable-dev-shm-usage`, `--single-process` for Lambda compatibility

## Frontend Integration

The frontend API route (`front_end/src/app/api/events/route.ts`) was updated to:
1. Load legacy Cal eProcure data (existing behavior, unchanged)
2. Load v2 manifests from all sources under `scrapes/v2/manifests/`
3. Filter out closed events
4. Merge both datasets, deduplicating by title
5. Serve the combined result to the dashboard

This means the frontend works with both the old single-source data and the new multi-source system during the transition period.

## Adding a New Site

### If the site uses PlanetBids
1. Find the portal ID (check the site's procurement page — it often redirects to `vendors.planetbids.com/portal/{ID}/...`)
2. Add an entry to `PLANETBIDS_AGENCIES` in `scrapers/planetbids.py`
3. Add the SiteConfig to the registry in `orchestrator/runner.py`

### If the site has a custom portal
Add it to the `agentic_sites` list in `orchestrator/runner.py`. The agentic scraper will handle discovery and extraction automatically.

### If you need a fully custom scraper
1. Create a new file in `scrapers/` extending `BaseScraper`
2. Implement the `scrape()` async generator method
3. Register it in `orchestrator/runner.py`'s `get_scraper()` factory

### Adding an EventBridge schedule for a new site
```bash
aws events put-rule --name civitas-scrape-SITEID --schedule-expression "rate(4 hours)" --state ENABLED
aws events put-targets --rule civitas-scrape-SITEID \
    --targets '[{"Id":"1","Arn":"arn:aws:lambda:us-east-1:681816819209:function:civitas-rfp-scraper","Input":"{\"site_id\":\"SITEID\"}"}]'
```
