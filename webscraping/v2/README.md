# Civitas RFP Scraping System v2

## Overview

The v2 scraping system collects RFPs (Requests for Proposals) from California government procurement sites. It replaces the original single-site Selenium scraper with a multi-source, multi-tier architecture that supports 33+ procurement sites across the state.

## Architecture

```
Scrapers (per-site)  →  Processing Pipeline  →  S3 Data Lake  →  Frontend API
```

### Three Scraper Tiers

| Tier | Type | Technology | When to Use | LLM Cost |
|------|------|-----------|-------------|----------|
| 1 | **API** | `httpx` / `aiohttp` | Site has an API or structured endpoints (BidSync) | None |
| 2 | **Structured** | Playwright | Known site with stable selectors (Cal eProcure, PlanetBids) | None |
| 3 | **Agentic** | Playwright + Claude Sonnet | Unknown site or when structured scrapers break | Only on first run; cached after |

### Registered Sites (33 total)

- **Cal eProcure** (1 site) — California state procurement portal
- **BidSync/Periscope** (~15 agencies) — Fresno, Bakersfield, Long Beach, Riverside County, San Bernardino County, Stockton, Modesto, Oxnard, Fontana, Moreno Valley, Pomona, Palmdale, Escondido, Torrance, Pasadena
- **PlanetBids** (~12 agencies) — Santa Clara County, San Mateo County, Santa Barbara, San Jose, Sunnyvale, Mountain View, Palo Alto, Redwood City, San Ramon, Dublin, Pleasanton, Hayward
- **Agentic** (5 sites) — City of Los Angeles, San Francisco, San Diego, Sacramento, Oakland

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
└── orchestrator/
    └── runner.py             # CLI entry point, site registry, pipeline orchestration
```

## Data Flow

1. **Scrape**: Each scraper produces `RawScrapedEvent` objects (source-agnostic schema)
2. **Enrich** (optional): PDFs are downloaded, text extracted with `pdfplumber`, and sent to Groq LLM for structured metadata (NAICS codes, certifications, clearances, etc.)
3. **Normalize**: Raw events + enrichment data are transformed into `EnrichedEvent` objects with inferred industry, location, and capabilities
4. **Upload**: Enriched events are written to S3 as per-source manifests at `scrapes/v2/manifests/{source_id}/latest.json`
5. **Frontend**: The Next.js API route (`/api/events`) reads all manifests, merges them with legacy data, deduplicates, and serves to the dashboard

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
- `industry`, `capabilities`, `certifications` (inferred)
- `location` (extracted from text or attachment data)
- `estimated_value`, `naics_codes`
- `clearances_required`, `set_aside_types`, `deliverables`
- `contract_duration`, `evaluation_criteria`
- `attachment_rollup` (summary + processed PDFs list)

## S3 Layout

```
civitas-uploads/
  scrapes/
    v2/
      events/{source_id}/{event_hash}.json      # Individual raw events
      manifests/{source_id}/latest.json          # Per-source event index (EnrichedEvent[])
      recipes/{source_id}.json                   # Cached agentic scraper recipes
    caleprocure/                                 # Legacy format (backward compat)
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
export AWS_STORAGE_BUCKET_NAME=civitas-uploads
export GROQ_API_KEY=...           # for PDF enrichment
export ANTHROPIC_API_KEY=...      # for agentic scraper only
```

### Running

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

# BidSync (first registered agency)
python -m webscraping.v2.scrapers.bidsync

# PlanetBids (first registered agency)
python -m webscraping.v2.scrapers.planetbids

# Agentic scraper on a custom URL
python -m webscraping.v2.scrapers.agentic https://www.lacity.org/for-businesses/bids-contracts la_city
```

## The Agentic Scraper

The agentic scraper is the key differentiator — it allows adding new procurement sites without writing site-specific code.

### How it works

1. **Discovery**: Claude Sonnet navigates the site to find the RFP listing page (looks for "Current Bids", "Open Solicitations", etc.)
2. **Recipe generation**: The agent analyzes the page HTML and generates a JSON "recipe" — CSS selectors for the listing container, individual fields (title, due date, agency, detail URL), and pagination controls
3. **Recipe caching**: The recipe is saved to S3 so subsequent runs use it directly with zero LLM cost
4. **Self-healing**: If a cached recipe returns zero results (e.g., the site changed its layout), the agent automatically re-discovers and generates a new recipe

### Recipe format

```json
{
  "listing_selector": "table.bids-table tbody tr",
  "fields": {
    "title": { "selector": "td:nth-child(2) a", "attribute": "text" },
    "due_date": { "selector": "td:nth-child(4)", "attribute": "text" },
    "detail_url": { "selector": "td:nth-child(2) a", "attribute": "href" }
  },
  "pagination": {
    "type": "next_button",
    "selector": "a.next-page"
  }
}
```

## Frontend Integration

The frontend API route (`front_end/src/app/api/events/route.ts`) was updated to:
1. Load legacy Cal eProcure data (existing behavior, unchanged)
2. Load v2 manifests from all sources under `scrapes/v2/manifests/`
3. Merge both datasets, deduplicating by title
4. Serve the combined result to the dashboard

This means the frontend works with both the old single-source data and the new multi-source system during the transition period.

## Adding a New Site

### If the site uses BidSync or PlanetBids
Add an entry to the `BIDSYNC_AGENCIES` or `PLANETBIDS_AGENCIES` dict in the respective scraper file. The buyer/portal ID can be found by inspecting the site's URL.

### If the site has a custom portal
Add it to the `agentic_sites` list in `orchestrator/runner.py`. The agentic scraper will handle discovery and extraction automatically.

### If you need a fully custom scraper
1. Create a new file in `scrapers/` extending `BaseScraper`
2. Implement the `scrape()` async generator method
3. Register it in `orchestrator/runner.py`'s `get_scraper()` factory
