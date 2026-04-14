# Civitas RFP Scraping System v2

## Overview

The v2 scraping system collects RFPs (Requests for Proposals) from 62 California government procurement sites. It runs on AWS Lambda (container-based) with EventBridge scheduling, scraping every 4 hours automatically.

## Architecture

```
EventBridge ("rate(4 hours)")
    │
    ▼
Lambda (civitas-rfp-scraper)  ──▶  {"mode": "all"}
    │
    ├── Cal eProcure (Playwright, ~625 events, chained batches)
    ├── PlanetBids (Playwright, 43 portals)
    ├── BidSync/Periscope (Playwright, CA-filtered search)
    └── Agentic (Playwright + Claude, 2 custom portals)
            │
            ▼
      Pipeline: normalize → enrich (optional) → merge → S3
            │
            ▼
      Frontend API (/api/events) reads S3 manifests
```

### Scraper Tiers

| Tier | Type | Technology | Sites | Status |
|------|------|-----------|-------|--------|
| Structured | **Cal eProcure** | Playwright | 1 (state-level) | Tested locally. May be IP-blocked from AWS. |
| Structured | **PlanetBids** | Playwright | 43 portals | Tested: San Diego, Sacramento, Fresno, Anaheim (30 events each) |
| Structured | **BidSync/Periscope** | Playwright + JSF | 15 agencies | Tested: 35 CA bids via Advanced Search with CA state filter |
| Agentic | **Custom portals** | Playwright + Claude Sonnet | 2 (LA, SF) | Recipe-cached after first run |

### Site Coverage

**PlanetBids (43 agencies):** San Diego, Sacramento, Riverside, Santa Ana, Anaheim, Fresno, Glendale, Fontana, Moreno Valley, San Bernardino, Bakersfield, Torrance, Pasadena, Downey, Costa Mesa, Inglewood, Pomona, Burbank, Norwalk, Carson, Chula Vista, Rialto, Jurupa Valley, Corona, El Cajon, Goleta, Huntington Beach, Carlsbad, Santa Fe Springs, Palm Springs, Maywood, Palmdale, La Mesa, San Marcos, National City, South Pasadena, Port of Long Beach, Port of San Diego, BGP Airport Authority, Riverside Transit Agency, SCAG, CSU Fresno

**BidSync (15 agencies):** City of Long Beach, City of Hayward, City of Berkeley, City of Palo Alto, County of Orange, County of Santa Clara, County of Solano, County of Ventura, Contra Costa County, Shasta County, Orange County Fire Authority, SMUD, SFMTA, Santa Clara Valley Water District, LAUSD

**Agentic (2 sites):** City of Los Angeles (labavn.org), City of San Francisco (sfgov.org)

## Project Structure

```
webscraping/v2/
├── config.py                 # AWS/LLM credentials from environment
├── models.py                 # Pydantic schemas (data contracts)
├── utils.py                  # Shared utilities (hashing, ID generation)
├── requirements.txt
├── scrapers/
│   ├── base.py               # BaseScraper ABC (throttling, S3 upload, dedup)
│   ├── caleprocure.py        # Cal eProcure (Playwright, structured)
│   ├── bidsync.py            # BidSync/Periscope (Playwright, JSF Advanced Search)
│   ├── planetbids.py         # PlanetBids (Playwright, Ember.js portals)
│   └── agentic.py            # LLM-powered auto-adaptation scraper
├── pipeline/
│   ├── normalize.py          # Industry/location/capability inference
│   └── enrich.py             # PDF text extraction + Groq LLM enrichment
├── orchestrator/
│   └── runner.py             # CLI entry point, site registry, pipeline orchestration
└── deploy/
    ├── Dockerfile            # Lambda container image (Playwright + Chromium)
    ├── lambda_handler.py     # Lambda entry point (single-site, multi-site, run-all)
    ├── template.yaml         # SAM template (Lambda + EventBridge)
    ├── buildspec.yml         # CodeBuild spec for building Docker image
    ├── aws-setup.sh          # One-command AWS infrastructure setup
    └── deploy.sh             # Docker-based deploy (requires Docker locally)
```

## Data Flow

1. **Scrape**: Each scraper produces `RawScrapedEvent` objects
2. **Enrich** (optional): PDFs downloaded, text extracted with `pdfplumber`, sent to Groq LLM for structured metadata (NAICS codes, certifications, clearances, etc.)
3. **Normalize**: Infer industry, location, and capabilities from text
4. **Merge**: New events merged with existing S3 data. Events no longer on source site are marked `closed` (never deleted)
5. **Upload**: Per-source manifests at `scrapes/v2/manifests/{source_id}/latest.json`
6. **Frontend**: `/api/events` reads all manifests, filters closed events, deduplicates, serves to dashboard

## Usage

### Local Setup

```bash
pip install -r webscraping/v2/requirements.txt
playwright install chromium

# Credentials are loaded from back_end/.env automatically
```

### Running Locally

```bash
# List all 62 registered sites
python -m webscraping.v2.orchestrator.runner --list

# Run a specific site
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego

# Skip PDF enrichment (faster)
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego --skip-enrich

# Skip S3 upload (local testing)
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego --skip-upload

# Run all enabled sites
python -m webscraping.v2.orchestrator.runner
```

### Testing Individual Scrapers

```bash
python -m webscraping.v2.scrapers.planetbids    # First PlanetBids agency
python -m webscraping.v2.scrapers.caleprocure   # Cal eProcure
python -m webscraping.v2.scrapers.agentic https://www.labavn.org/ la_city
```

## AWS Deployment

### What's Deployed

| Resource | Name | Purpose |
|----------|------|---------|
| ECR | `civitas-scraper` | Container image registry |
| Lambda | `civitas-rfp-scraper` | Runs scraping pipeline (container, 15min timeout) |
| EventBridge | `civitas-scrape-all` | Triggers Lambda every 4 hours with `{"mode": "all"}` |
| CodeBuild | `civitas-scraper-build` | Builds Docker image remotely |
| IAM | `civitas-scraper-lambda-role` | Lambda execution (S3 + self-invoke) |

### Lambda Invocation Modes

```bash
# Run all sites
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"mode":"all","skip_enrich":true}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json

# Run specific sites
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"sites":["planetbids_san_diego","planetbids_fresno"]}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json

# Run single site with chained batching (Cal eProcure)
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"site_id":"caleprocure","batch_offset":0,"batch_size":40}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json
```

### Deploying Code Changes

```bash
# Rebuild container via CodeBuild (uses main branch)
aws codebuild start-build --project-name civitas-scraper-build --source-version main

# Check build status
aws codebuild batch-get-builds --ids <build-id> --query 'builds[0].buildStatus'

# Check Lambda logs
aws logs tail /aws/lambda/civitas-rfp-scraper --follow --region us-east-1
```

### First-Time Infrastructure Setup

```bash
bash webscraping/v2/deploy/aws-setup.sh
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
Add to `BIDSYNC_AGENCIES` in `scrapers/bidsync.py`. The scraper searches all CA bids at once and attributes by agency name, so new agencies are matched automatically if the name appears in results.

### Custom portal
Add to the `agentic_sites` list in `orchestrator/runner.py`. The agentic scraper auto-discovers the site structure using Claude Sonnet.

### Fully custom scraper
1. Create a file in `scrapers/` extending `BaseScraper`
2. Implement the `scrape()` async generator
3. Add routing in `runner.py`'s `get_scraper()` factory

## GitHub Actions (Manual Fallback)

The `.github/workflows/scrape.yml` workflow can trigger scraping manually from GitHub's UI. It runs on GitHub-hosted runners (useful if Lambda IPs are blocked by a site). No scheduled trigger — Lambda handles automated runs.

Secrets required in repo settings: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_STORAGE_BUCKET_NAME`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`
