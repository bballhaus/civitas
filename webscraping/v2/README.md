# Civitas RFP Scraping System v2

## Overview

The v2 scraping system collects RFPs (Requests for Proposals) from California
state, county, and municipal procurement portals. It runs on AWS Lambda
(container image) and is triggered by EventBridge every 48 hours.

Sources fall into four families:

- **Cal eProcure** — 1 state-level portal (~530 active events). Full pipeline:
  inline PDF download → text extraction → LLM enrichment.
- **PlanetBids** — 43 city/county portals. Per-portal vendor login provides
  market intel (prospective bidders / bid results / awards). Document downloads
  are gated per-agency by `vendor_registered` flag.
- **BidSync / Periscope** — 15 CA agencies via one Advanced Search.
  Search-result metadata only.
- **OpenGov Procurement** — Multi-tenant SaaS. Scraper exists; **currently
  blocked by Cloudflare bot detection.** See "Known Limitations" below.

Three agentic Lambda modes (`discover`, `onboard`, `monitor`) help expand
coverage and surface health.

## Architecture

```
EventBridge ("rate(48 hours)")
    │
    ▼
Lambda (civitas-rfp-scraper)  ──▶  {"mode": "all"}
    │
    ├─▶ Cal eProcure   (single-site chained batches of 15 events)
    │     └─ inline PDF download + Claude Haiku 4.5 enrichment
    │
    ├─▶ BidSync all_ca (one invocation covers all CA agencies)
    │
    ├─▶ PlanetBids     (per-portal chained batches of 5 events,
    │                  staggered 90s; vendor_registered=True
    │                  unlocks the Documents tab download)
    │
    └─▶ OpenGov        (per-portal chained batches of 6 events;
                       blocked by Cloudflare today)

           Pipeline: scrape → enrich (PDF text → Anthropic) →
                     normalize → merge with prior → write S3 manifest
                                          │
                                          ▼
                          /api/events reads manifests → dashboard
```

### Lambda modes

| Mode | Payload example | Purpose |
|------|-----------------|---------|
| (default) all | `{"mode":"all"}` | Fan out scrapes for every enabled portal. |
| single site | `{"site_id":"caleprocure","batch_offset":0,"batch_size":15}` | One portal, chained batching. `expected_total` propagates through the chain so downstream invocations stop after the listing ends. |
| sites batch | `{"sites":[...], "remaining_sites":[...]}` | Multi-site batch with chain-first stagger. |
| **discover** | `{"mode":"discover","platform":"opengov"}` | Use Claude to enumerate candidate CA agencies on a platform; verify each with a Playwright probe; save candidates to `s3://.../scrapes/v2/discovered/{platform}.json`. |
| **onboard** | `{"mode":"onboard","platform":"opengov","max_per_run":5}` | Probe verified candidates with the platform's scraper; if they yield ≥1 event with a real title, write them into `s3://.../scrapes/v2/registry/{platform}.json` so the registry picks them up next run — no code deploy. |
| **monitor** | `{"mode":"monitor","stale_hours":72}` | Roll up per-source health into a single `_summary.json`; return the list of sources whose last successful scrape is older than `stale_hours` or whose consecutive_failures exceeds the tripwire. |

### Source coverage matrix

See [COVERAGE.md](COVERAGE.md) for the full field-by-field matrix. Quick read:

| Source | Sites | Auth | PDFs | Market intel | Status |
|---|---|---|---|---|---|
| Cal eProcure | 1 | — | inline | — | active |
| PlanetBids | 43 | shared cross-portal vendor login | gated; `vendor_registered=True` opens Documents tab (San Diego only today) | ✓ bidders / results / awards | active |
| BidSync | 15 | none | n/a | — | active (metadata only) |
| OpenGov | 1 in registry (Pasadena) | — | — | — | blocked by Cloudflare |
| Agentic (LA, SF) | 2 | — | n/a | — | disabled in registry |

### LLM enrichment

PDF text → structured metadata (NAICS codes, certifications, licenses,
clearances, deliverables, evaluation criteria, incumbent vendor & contract
end). Provider chosen by `LLM_PROVIDER` env var:

- `anthropic` (default) — Claude Haiku 4.5 with prompt caching on the
  ~1 KB extraction system prompt. After the first call, subsequent PDFs
  pay only for per-PDF user text. Strong structured output, low false-
  positive rate.
- `groq` — `llama-3.1-8b-instant`. Fast and free tier, but produces
  noisier extractions (e.g., spurious license requirements). Kept as a
  fallback escape hatch.

`certifications_required` and `licenses_required` stay separate — certs
cover status / preference programs (DBE, MBE, DIR registration,
ISO 27001), licenses cover trade or professional licenses (CSLB Class A,
C-10 Electrical, PE License). Class designations are licenses, not
certifications.

### Per-portal pagination

Each large source paginates internally so individual Lambda invocations
fit inside the 15-minute budget:

- **Cal eProcure**: 15 events per invocation (~7 min each).
- **PlanetBids**: 5 events per invocation. Each detail page is ~70-80s
  once login + tabs + market intel are accounted for, so 5 leaves
  ~10 min of headroom.
- **OpenGov**: 6 events per invocation.

The chain is "chain-first": each invocation dispatches the next batch
*before* running its scrape, so a Lambda timeout doesn't kill the chain.
`expected_total` propagates through the chain to stop runaway invocations
when the listing ends.

### Health monitoring

Every `run_site` / `run_site_batch` writes a heartbeat to
`s3://.../scrapes/v2/health/{source_id}.json`:

```json
{
  "source_id": "...",
  "source_name": "...",
  "last_success_at": "...",
  "last_attempt_at": "...",
  "consecutive_failures": 0,
  "last_events_scraped": 27,
  "last_pdfs_observed": 12,
  "last_error": ""
}
```

Plus a CloudWatch metric `Civitas/Scraping/EventsScraped`/`RunSuccess`
keyed by `SourceId`. The Lambda role has `cloudwatch:PutMetricData`.

`mode=monitor` rolls these up to `s3://.../scrapes/v2/health/_summary.json`
with the list of stale or repeatedly-failing sources.

## Project Structure

```
webscraping/v2/
├── config.py                 # AWS/LLM config, get_s3_client(), LLM_PROVIDER
├── models.py                 # Pydantic schemas (RawScrapedEvent, EnrichedEvent, ...)
├── utils.py                  # Hashing, ID generation
├── requirements.txt
├── tests/
│   └── test_unit.py          # 65 unit tests (models, normalize, merge, registry)
├── scrapers/
│   ├── base.py               # BaseScraper ABC (throttling, S3 helpers)
│   ├── caleprocure.py        # Cal eProcure (Playwright; inline PDF fetch via context.request)
│   ├── bidsync.py            # BidSync/Periscope (Playwright, JSF Advanced Search)
│   ├── planetbids.py         # PlanetBids (Playwright, vendor login, market intel,
│   │                         #   vendor_registered Documents-tab download)
│   ├── opengov.py            # OpenGov Procurement (Playwright; multi-tenant)
│   └── agentic.py            # Generic Claude+Playwright recipe scraper
├── pipeline/
│   ├── normalize.py          # Industry/location/capability inference
│   ├── enrich.py             # PDF text extraction + Anthropic/Groq enrichment
│   └── health.py             # Per-source heartbeat + CloudWatch metric + summary
├── agents/
│   ├── discovery.py          # Enumerate + probe candidate platform instances
│   └── onboarding.py         # Probe and register candidates via S3
├── orchestrator/
│   └── runner.py             # CLI entry point, site registry, run_site, run_site_batch
└── deploy/
    ├── Dockerfile            # Lambda container image (Playwright + Chromium)
    ├── lambda_handler.py     # Lambda entry point (all modes)
    ├── template.yaml         # SAM template (Lambda + EventBridge)
    ├── buildspec.yml         # CodeBuild spec
    └── aws-setup.sh          # One-command AWS infra setup
```

## Usage

### Local Setup

```bash
pip install -r webscraping/v2/requirements.txt
playwright install chromium
# Credentials loaded from back_end/.env automatically
```

### Running locally

```bash
# List all registered sites (incl. S3-onboarded OpenGov entries)
python -m webscraping.v2.orchestrator.runner --list

# Run a specific site (scrape + enrich + upload)
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego

# Skip PDF enrichment (faster)
python -m webscraping.v2.orchestrator.runner --site caleprocure --skip-enrich

# Skip S3 upload (purely local testing)
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego --skip-upload

# Also scrape Awarded-status events (PlanetBids only)
python -m webscraping.v2.orchestrator.runner --site planetbids_san_diego --include-awarded

# Run discovery agent end-to-end
python -m webscraping.v2.agents.discovery opengov

# Run onboarding pipeline
python -m webscraping.v2.agents.onboarding opengov 5
```

### PlanetBids credentials

Market-intel scraping requires a logged-in vendor session. Credentials are
stored in AWS Secrets Manager at `civitas/scraping/planetbids` as JSON
`{"username": "...", "password": "..."}`. The Lambda role
`civitas-scraper-lambda-role` has `secretsmanager:GetSecretValue` on this
secret.

The shared account is domain-scoped to `vendors.planetbids.com`, so one
login covers all 43 portals. **Per-agency vendor registration** (which
unlocks the Documents tab on a specific portal) is tracked separately
via the `vendor_registered: True` flag in `PLANETBIDS_AGENCIES`. Today
San Diego is the only flagged portal — see "Known Limitations" for the
current state.

For local dev without AWS access, set `PLANETBIDS_USERNAME` /
`PLANETBIDS_PASSWORD` env vars; `get_secret()` falls back to env vars.

### LLM provider config

`ANTHROPIC_API_KEY` enables Claude Haiku 4.5 enrichment (default).
`LLM_PROVIDER=groq` falls back to Groq llama-3.1-8b. Both keys live in
the Lambda env vars today; moving them to Secrets Manager is on the
TODO list.

### Tests

```bash
python -m pytest webscraping/v2/tests/test_unit.py -v
```

## AWS Deployment

### What's deployed

| Resource | Name | Purpose |
|----------|------|---------|
| ECR | `civitas-scraper` | Container image registry |
| Lambda | `civitas-rfp-scraper` | Container, 15-min timeout, 2 GB RAM, 10 GB `/tmp` |
| EventBridge | `civitas-scrape-all` | Triggers `{"mode":"all"}` every 48h |
| CodeBuild | `civitas-scraper-build` | Builds Docker image from GitHub |
| IAM | `civitas-scraper-lambda-role` | S3 CRUD, self-invoke, secrets read, CloudWatch metrics |

### Lambda invocation

```bash
# Run all sites (dispatches batched async invocations)
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"mode":"all"}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json

# Run a specific site (chained pagination)
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"site_id":"planetbids_san_diego","batch_offset":0,"batch_size":5}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json

# Discover new platform instances
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"mode":"discover","platform":"opengov"}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json

# Onboard verified candidates
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"mode":"onboard","platform":"opengov","max_per_run":5}' \
    --invocation-type Event --cli-binary-format raw-in-base64-out /tmp/out.json

# Roll up per-source health
aws lambda invoke --function-name civitas-rfp-scraper \
    --payload '{"mode":"monitor","stale_hours":72}' \
    --invocation-type RequestResponse --cli-binary-format raw-in-base64-out /tmp/out.json
```

### Deploying code changes

```bash
# Rebuild container via CodeBuild against your branch
aws codebuild start-build --project-name civitas-scraper-build \
    --source-version brooke/webscraping

# Force Lambda to pull the new image (invalidates warm instances)
aws lambda update-function-configuration --function-name civitas-rfp-scraper \
    --description "Updated $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Tail logs
aws logs tail /aws/lambda/civitas-rfp-scraper --follow --region us-east-1
```

## Adding a new site

### Static (in-code) — PlanetBids agency
Add an entry to `PLANETBIDS_AGENCIES` in `scrapers/planetbids.py`:
```python
"planetbids_cityname": {
    "portal_id": "XXXXX",
    "name": "City of Cityname",
    "url": "https://vendors.planetbids.com/portal/XXXXX/bo/bo-search",
    # Optional. True once Civitas LLC is registered as a vendor with the agency.
    "vendor_registered": False,
},
```

### Static — BidSync agency
Add to `BIDSYNC_AGENCIES` in `scrapers/bidsync.py`. The scraper searches
all CA bids at once and attributes by agency name.

### Static — OpenGov agency
Add to `OPENGOV_AGENCIES` in `scrapers/opengov.py`. The OpenGov scraper
walks `procurement.opengov.com/portal/{slug}` for that agency.

### Dynamic (no code deploy) — onboarding pipeline
The recommended path for new OpenGov agencies once the Cloudflare blocker
is solved: trigger `mode=discover`, review the candidates in
`s3://.../scrapes/v2/discovered/opengov.json`, then trigger
`mode=onboard`. Vetted candidates are appended to
`s3://.../scrapes/v2/registry/opengov.json` and picked up on the next
Lambda invocation by `get_opengov_site_configs()`.

## Known limitations

- **OpenGov is currently blocked by Cloudflare.** Headless Chromium —
  even with the stealth init scripts and `playwright-stealth` — receives
  the "Just a moment / Performing security verification" challenge that
  never auto-resolves. The scraper, the discovery probes, and any future
  onboarding probes all hit this wall. Resolving needs one of:
  (a) a residential-proxy or managed-scraping-API service (Bright Data,
  ScrapingBee), (b) reverse-engineering OpenGov's underlying JSON API,
  or (c) accepting that OpenGov isn't tractable today and adding
  Bonfire / IonWave / Public Purchase / eBidBoard instead. The discovery
  verifier rejects challenge pages so we don't false-positive them.

- **PlanetBids Documents tab is not yet pulling docs.** As of this
  writing, 0 of 41 events on `planetbids_san_diego` have ever had
  `public_documents` populated. Both the legacy filename heuristic and
  the new `vendor_registered` download path miss the actual DOM the
  Documents tab renders. Investigating.

- **BidSync detail pages require login** — only search-result metadata
  is collected. Description and attachments need authentication.

- **Agentic scrapers (LA City, SF City) are disabled.** LA's
  `labavn.org` DNS-fails on Lambda; SF's contracting opportunities URL
  is a 404. They'll be re-onboarded via the agentic onboarding pipeline
  when its target sites are reachable.

- **Cal eProcure full scrape takes ~5 hours.** ~530 events × 15 per
  batch × ~7 min per batch, chained. Runs as background invocations.

- **API keys are in plaintext Lambda env vars.** Anthropic and Groq.
  Moving to Secrets Manager is on the TODO list.

- **Single shared PlanetBids account = single point of failure.** All
  43 portals depend on the same domain-scoped login. If any one portal
  blocks the account, all 43 die at once.
