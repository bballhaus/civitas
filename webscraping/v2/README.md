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

### ScrapingBee (Cloudflare bypass)

OpenGov Procurement is fronted by Cloudflare bot detection. Headless
Chromium with stealth init scripts does NOT pass — the "Just a
moment / Performing security verification" challenge does not
auto-resolve. We bypass it by routing OpenGov fetches through
ScrapingBee with `stealth_proxy=true&render_js=true`.

**Setup:**

1. Sign up at scrapingbee.com (Pro plan recommended for OpenGov —
   $99/mo, 250K credits/mo). Verify the email.
2. Store the API key in AWS Secrets Manager:
   ```bash
   aws secretsmanager create-secret \
     --name civitas/scraping/scrapingbee \
     --secret-string '{"api_key":"YOUR_KEY"}' \
     --region us-east-1
   ```
   The Lambda role already has `secretsmanager:GetSecretValue` on
   `civitas/scraping/*`. Local dev: set `SCRAPINGBEE_API_KEY` env var.
3. Sanity-check with their `/usage` endpoint:
   ```bash
   curl -G "https://app.scrapingbee.com/api/v1/usage" \
     --data-urlencode "api_key=YOUR_KEY"
   ```

**Integration mode — API, not proxy.** ScrapingBee supports two
integration patterns. We use the API endpoint exclusively:
- *Proxy mode* (`proxy.scrapingbee.com:8886`) — does **not** expose
  `stealth_proxy`, which is what OpenGov's Cloudflare config requires.
  Returns `Not found :(`. Tried and abandoned.
- *API mode* (`https://app.scrapingbee.com/api/v1/`) — we GET their
  endpoint with target URL + flags; they return rendered HTML. With
  `stealth_proxy=true&render_js=true`, Cloudflare is bypassed and we
  get the post-React-hydration HTML. This is what
  `scrapers/opengov.py` and the OpenGov path of `agents/discovery.py`
  use today (via `config.fetch_via_scrapingbee`).

**OpenGov scraper is listing-only.** OpenGov's React app navigates to
bid detail pages via Angular click handlers — bid cards render as
`<a href="#">` with the navigation hidden in JS state. Until the
detail-URL pattern is reverse-engineered (one manual DevTools
inspection of the click-fired GraphQL/REST call, or an Apollo-state
parse), the OpenGov scraper yields *listing-only* events: title,
bid number, agency, status, deadline. No description, no PDFs, no
LLM enrichment. Listing-only events still flow through the rest of
the pipeline; the attachment-enrichment pass is a no-op when
`attachment_texts` is empty.

**Credit math (API mode):**
- `render_js=true` + `stealth_proxy=true` ≈ 75 credits per page.
- One Pasadena listing-only scrape ≈ 75 credits.
  (When detail-URL parsing lands, add ~75 × N detail pages — for
  Pasadena's ~11 active bids that's ~900 credits per run.)
- Pro plan: 250K credits/mo. Listing-only at 75 credits/run → 3,300
  scrapes/mo. Plenty.
- Discovery probe = listing-only fetch ≈ 75 credits per candidate. A
  full 30-candidate run ≈ 2,250 credits. Cheap.

**Which scrapers route through ScrapingBee:**
- `scrapers/opengov.py` — always (API mode + BeautifulSoup; no
  Playwright). Skips the run entirely if no API key is configured.
- `agents/discovery.py` — only for platforms with
  `PlatformProfile.requires_proxy=True` (currently just `opengov`).
  Probes for those platforms use the same API-mode HTTP path; other
  platforms continue to use direct Playwright probes.
- Cal eProcure / PlanetBids / BidSync — never. No Cloudflare in
  front, so routing them through ScrapingBee would burn credits with
  no benefit.

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

- **OpenGov sits behind Cloudflare bot detection.** Bypass requires
  ScrapingBee API mode (`stealth_proxy=true&render_js=true`); see
  "ScrapingBee (Cloudflare bypass)" above. Code path is being
  rewritten from Playwright-proxy to API-mode — until that lands,
  OpenGov scrapes still produce zero events even with the API key
  configured. The discovery verifier already rejects Cloudflare
  interstitials so they do not false-positive.

- **OpenGov bid-card → detail-page mapping is unsolved.** Bid cards
  on a portal listing render as `<a href="#">` Angular click-handlers
  (same pattern as PlanetBids). The visible bid number ("2026-RFP-
  0123") is plain text in a sibling cell, but the URL pattern that
  the React app uses for detail navigation is opaque — internal IDs
  live in JS state, not in any href. Resolving this needs either
  network-tab inspection of one click event (cheap, one-time) or
  reverse-engineering the GraphQL/REST endpoint OpenGov's app uses
  internally. Until resolved, OpenGov can only deliver listing-page
  fields (title, bid number, agency, status), not full enrichment.

- **PlanetBids gated documents require per-bid Prospective Bidder
  registration, NOT per-agency vendor registration.** Even with the
  shared cross-portal vendor login AND a per-agency vendor signup on
  the agency, clicking "Download" on a `*`-prefixed (private) document
  opens a "Become a Prospective Bidder — You must become a Prospective
  Bidder to download private documents" modal. Becoming a PB on each
  bid is one click + likely a ToS issue + listed on the public
  Prospective Bidders tab, so we don't automate it. The
  `_download_documents_tab` code path detects the modal and logs the
  count of gated docs per bid; non-gated public docs (rare on most
  CA portals) are downloaded normally. The `vendor_registered` flag is
  retained on `PLANETBIDS_AGENCIES` entries as a hint but is currently
  a no-op for download purposes.

  Net implication: PlanetBids events stay market-intel-only
  (`prospective_bidders`, `bid_results`, `award`). LLM-extracted RFP
  fields (NAICS, certs, licenses, deliverables) come only from
  Cal eProcure today.

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
