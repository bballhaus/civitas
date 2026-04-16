# Civitas RFP Scraping System v2

## Overview

The v2 scraping system collects RFPs (Requests for Proposals) from 43 California government procurement sites. It runs on AWS Lambda (container-based) with EventBridge scheduling every 48 hours (dev mode).

## Architecture

```
EventBridge ("rate(48 hours)")
    │
    ▼
Lambda (civitas-rfp-scraper)  ──▶  {"mode": "all"}
    │
    ├─▶ Cal eProcure  (chained batches of 15, ~43 invocations)
    │     └─ Downloads PDFs inline, extracts text, sends to Groq LLM
    │
    ├─▶ BidSync all_ca  (single invocation, searches all CA bids)
    │
    └─▶ PlanetBids  (batches of 3 agencies, chained)
          └─ Visits detail pages for description, contact, categories
            │
            ▼
      Pipeline: scrape → enrich (inline PDFs) → normalize → merge → S3
            │
            ▼
      Frontend API (/api/events) reads S3 manifests → Dashboard
```

### Scraper Tiers

| Tier | Type | Sites | Data Collected |
|------|------|-------|----------------|
| Structured | **Cal eProcure** | 1 (state-level, ~642 events) | Title, description, contact, PDFs (downloaded + LLM-enriched), attachment URLs |
| Structured | **PlanetBids** | 42 portals | Title, description, contact, categories (NAICS-like), public addenda |
| Structured | **BidSync/Periscope** | 15 agencies (1 search) | Title, agency, due date (detail pages require login) |
| Agentic | **Custom portals** | 2 (LA, SF) | Not yet working on Lambda (see TODO) |

### Lambda Batching

The `mode: all` handler dispatches sites as parallel async Lambda invocations:
- **Cal eProcure**: Chained batches of 15 events. Each invocation scrapes 15 events, downloads their PDFs inline via Playwright, enriches via Groq LLM, uploads to S3, then self-invokes with the next offset.
- **BidSync**: Single invocation — one Advanced Search covers all CA agencies.
- **PlanetBids**: Batches of 3 agencies per invocation, chained. Each agency's detail pages are visited for description, contact, and categories.
- `/tmp` cleanup runs between sites to prevent ENOSPC. Lambda has 10GB ephemeral storage.

## Data Flow

1. **Scrape**: Each scraper produces `RawScrapedEvent` objects with title, description, contact, attachment URLs
2. **Download** (Cal eProcure only): PDFs downloaded inline via Playwright (session-bound URLs), text extracted with `pdfplumber`
3. **Enrich**: Pre-extracted PDF text sent to Groq LLM (`llama-3.1-8b-instant`) for structured metadata (NAICS codes, certifications, clearances, deliverables, evaluation criteria)
4. **Normalize**: Infer industry, location, and capabilities from text via regex rules
5. **Merge**: New events merged with existing S3 data. Missing events marked `closed` (never deleted)
6. **Upload**: Per-source manifests at `scrapes/v2/manifests/{source_id}/latest.json`
7. **Frontend**: `/api/events` reads all manifests, filters closed events, deduplicates, serves to dashboard

## Project Structure

```
webscraping/v2/
├── config.py                 # AWS/LLM credentials, get_s3_client() helper
├── models.py                 # Pydantic schemas (RawScrapedEvent, EnrichedEvent, etc.)
├── utils.py                  # Shared utilities (hashing, ID generation)
├── requirements.txt
├── tests/
│   └── test_unit.py          # 46 unit tests (models, normalize, merge, registry)
├── scrapers/
│   ├── base.py               # BaseScraper ABC (throttling, S3 helpers)
│   ├── caleprocure.py        # Cal eProcure (Playwright, inline PDF download)
│   ├── bidsync.py            # BidSync/Periscope (Playwright, JSF Advanced Search)
│   ├── planetbids.py         # PlanetBids (Playwright, Bidding filter, detail pages)
│   └── agentic.py            # LLM-powered auto-adaptation scraper
├── pipeline/
│   ├── normalize.py          # Industry/location/capability inference
│   └── enrich.py             # PDF text extraction + Groq LLM enrichment
├── orchestrator/
│   └── runner.py             # CLI entry point, site registry, pipeline orchestration
└── deploy/
    ├── Dockerfile            # Lambda container image (Playwright + Chromium)
    ├── lambda_handler.py     # Lambda entry point (batched multi-site chaining)
    ├── template.yaml         # SAM template (Lambda + EventBridge)
    ├── buildspec.yml         # CodeBuild spec for building Docker image
    └── aws-setup.sh          # One-command AWS infrastructure setup
```

## Usage

### Local Setup

```bash
pip install -r webscraping/v2/requirements.txt
playwright install chromium

# Credentials are loaded from back_end/.env automatically
```

### Running Locally

```bash
# List all registered sites
python -m webscraping.v2.orchestrator.runner --list

# Run a specific site (scrape + enrich + upload)
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego

# Skip PDF enrichment (faster)
python -m webscraping.v2.orchestrator.runner --site caleprocure --skip-enrich

# Skip S3 upload (local testing)
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego --skip-upload

# Run all enabled sites
python -m webscraping.v2.orchestrator.runner
```

### Running Tests

```bash
python -m pytest webscraping/v2/tests/test_unit.py -v
```

## AWS Deployment

### What's Deployed

| Resource | Name | Purpose |
|----------|------|---------|
| ECR | `civitas-scraper` | Container image registry |
| Lambda | `civitas-rfp-scraper` | Runs scraping pipeline (container, 15min timeout, 2GB RAM, 10GB /tmp) |
| EventBridge | `civitas-scrape-all` | Triggers Lambda every 48 hours with `{"mode": "all"}` |
| CodeBuild | `civitas-scraper-build` | Builds Docker image remotely |
| IAM | `civitas-scraper-lambda-role` | Lambda execution (S3 CRUD + self-invoke) |

### Lambda Invocation

```bash
# Run all sites (dispatches batched async invocations)
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"mode":"all"}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json

# Run specific sites
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"sites":["planetbids_san_diego","planetbids_fresno"]}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json

# Run Cal eProcure with chained batching
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"site_id":"caleprocure","batch_offset":0,"batch_size":15}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json

# Skip enrichment for faster scraping
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"mode":"all","skip_enrich":true}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json
```

### Deploying Code Changes

```bash
# Rebuild container via CodeBuild
aws codebuild start-build --project-name civitas-scraper-build --source-version webscraping

# Force Lambda to use new container (invalidates warm instances)
aws lambda update-function-configuration --function-name civitas-rfp-scraper \
    --description "Updated $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Check Lambda logs
aws logs tail /aws/lambda/civitas-rfp-scraper --follow --region us-east-1
```

## Adding a New Site

### PlanetBids agency
Add an entry to `PLANETBIDS_AGENCIES` in `scrapers/planetbids.py`:
```python
"planetbids_cityname": {
    "portal_id": "XXXXX",
    "name": "City of Cityname",
    "url": "https://vendors.planetbids.com/portal/XXXXX/bo/bo-search",
},
```
The registry in `runner.py` picks it up automatically.

### BidSync agency
Add to `BIDSYNC_AGENCIES` in `scrapers/bidsync.py`. The scraper searches all CA bids at once and attributes by agency name.

### Custom portal
Add to the `agentic_sites` list in `orchestrator/runner.py`. The agentic scraper auto-discovers the site structure using Claude Sonnet.

## Known Limitations

- **PlanetBids documents require vendor login** — most RFP PDFs are behind authentication (items marked with `*`). Public addenda are collected. Categories (NAICS-like codes) are extracted from detail pages without login.
- **BidSync detail pages require login** — only search result metadata (title, agency, due date) is collected. Description and attachments need authentication.
- **Agentic scrapers (LA City, SF City)** — not yet working on Lambda due to browser resource constraints. See `docs/TODO.md`.
- **Cal eProcure full scrape takes ~5 hours** — 642 events × 15 per batch × ~7 min per batch. Runs as background chained invocations.
- **Groq free tier** — rate limits may slow enrichment. 2-second sleep between API calls.
