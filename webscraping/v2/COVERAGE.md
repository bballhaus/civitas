# Coverage by Source

What each scraper actually populates on `EnrichedEvent`. "Empty" means
the field stays at its zero value (`[]`, `None`, or `""`) because the
source either doesn't expose the data, requires auth we don't have, or
the relevant scraper step hasn't been wired up.

The heterogeneity matters for matching: an RFP from Cal eProcure has
LLM-extracted requirements in `licenses_required` / `naics_codes`, while
an otherwise similar RFP from PlanetBids has those fields empty but has
rich `prospective_bidders` / `bid_results` instead.

## At-a-glance

| Source | Sites | Auth | PDFs | Market intel | Status |
|---|---|---|---|---|---|
| **Cal eProcure** | 1 (state-level, ~530 events) | None needed | Inline download via `page.context.request.get` (replaces the broken click-based flow) | — | **Active.** Full scrape ~5 h. |
| **PlanetBids** | 43 portals (Pasadena removed; migrated to OpenGov) | Shared cross-portal vendor login (Secrets Manager) | Gated; `vendor_registered=True` flag opens the Documents tab download path. **Currently broken** — see notes below. | ✓ Prospective Bidders / Bid Results / Awards | **Active.** `--include-awarded` adds historical archive. |
| **BidSync / Periscope** | 15 agencies (1 Advanced Search) | None | Detail pages require login (not scraped) | — | Active; search-result metadata only. |
| **OpenGov Procurement** | 1 in registry (Pasadena); discovery agent enumerates more | None expected for read-only public bids | ✓ Direct download from `attachment.url` returned by the detail API | — | **Active.** Direct JSON API at `api.procurement.opengov.com` (no Cloudflare on that host). Two-step scrape: `POST /api/v1/government/{slug}/project/public` for the listing, then `GET /api/v1/project/{id}` per row for full description + attachments + contact. ScrapingBee not in path. |
| **Agentic (LA City, SF City)** | 2 | n/a | n/a | n/a | **Disabled in registry.** LA fails DNS resolution on Lambda; SF URL is 404. |

LLM enrichment provider: Claude Haiku 4.5 (default) with prompt
caching on the system prompt. Groq llama-3.1-8b kept as a fallback via
`LLM_PROVIDER=groq`. `certifications_required` stays distinct from
`licenses_required` — see README for the rule.

## Field population matrix

Rows are `EnrichedEvent` fields; columns are sources.
✓ = populated when data exists on source · ◐ = sometimes populated · ✗ = always empty / not extracted.

**OpenGov** column reflects what the direct JSON API returns. Most
fields populate; the few exceptions are noted inline.

| Field | Cal eProcure | PlanetBids | BidSync | OpenGov | Agentic |
|---|:-:|:-:|:-:|:-:|:-:|
| **Identity** | | | | | |
| `id`, `source_id`, `source_event_id`, `source_url` | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Status tracking** | | | | | |
| `status`, `first_seen_at`, `last_seen_at`, `closed_at` | ✓ | ✓ | ✓ | ✓ | n/a |
| **Core fields** | | | | | |
| `title` | ✓ | ✓ | ✓ | ✓ | n/a |
| `description` | ✓ | ✓ (detail page) | ✗ | ✓ (`summary` field) | n/a |
| `agency` | ✓ | ✓ | ✓ | ✓ | n/a |
| `procurement_type` | ✓ | "Bid" (default) | ✗ | ✓ (parsed from `financialId`) | n/a |
| `posted_date` | ✓ | ✓ (when present) | ✗ | ✓ (`releaseProjectDate`) | n/a |
| `deadline` (due_date) | ✓ | ✓ | ✓ | ✓ (`proposalDeadline`) | n/a |
| **Contact** | | | | | |
| `contact.name` | ✓ | ✓ (detail page) | ✗ | ✓ (`contactDisplayName`) | n/a |
| `contact.email` | ✓ | ✓ (detail page) | ✗ | ✓ (`contactEmail`) | n/a |
| `contact.phone` | ✓ | ✓ (detail page) | ✗ | ✓ (`contactPhoneComplete`) | n/a |
| **Attachments** | | | | | |
| `attachment_urls` | ✓ (signed URLs) | ◐ (gated; `vendor_registered=True` opens Documents tab) | ✗ | ✓ (public S3 URLs from API) | n/a |
| **Inferred (regex/text)** | | | | | |
| `industry`, `capabilities`, `location`, `estimated_value` | ✓ | ✓ (from title+desc) | ◐ (title only) | ✓ (from title+summary) | n/a |
| **LLM-extracted from PDFs** | | | | | |
| `naics_codes` | ✓ | ✗ (Documents tab broken) | ✗ | ✓ | n/a |
| `certifications` (RFP-required) | ✓ | ✗ | ✗ | ✓ | n/a |
| `licenses_required` | ✓ | ✗ | ✗ | ✓ | n/a |
| `clearances_required` | ✓ | ✗ | ✗ | ✓ | n/a |
| `set_aside_types` | ✓ | ✗ | ✗ | ✓ | n/a |
| `deliverables` | ✓ | ✗ | ✗ | ✓ | n/a |
| `evaluation_criteria` | ✓ | ✗ | ✗ | ✓ | n/a |
| `contract_duration` | ✓ | ✗ | ✗ | ✓ | n/a |
| `attachment_rollup` (PDF text snippet) | ✓ | ✗ | ✗ | ✓ | n/a |
| `incumbent_vendor` / `incumbent_contract_end` | ✓ | ✗ | ✗ | ✓ | n/a |
| **Market intel (PlanetBids tabs)** | | | | | |
| `prospective_bidders[]` | ✗ | ✓ | ✗ | ✗ | n/a |
| `bid_results[]` (closed bids) | ✗ | ✓ | ✗ | ✗ | n/a |
| `award` (awarded bids) | ✗ | ✓ | ✗ | ✗ | n/a |
| **Source-specific (raw_metadata stash)** | | | | | |
| `categories` | ✗ | ✓ (NAICS-like, in `raw_metadata`) | ✗ | ✗ | n/a |
| `public_documents` (filename list) | ✗ | ◐ (Documents-tab heuristic broken on most portals) | ✗ | ✗ | n/a |
| `org_name_raw` | ✗ | ✗ | ✓ | ✗ | n/a |

## Per-source typical EnrichedEvent

These are illustrative shapes — only the fields likely to be populated
for a representative event from each source. Empty fields are omitted
for readability.

### Cal eProcure (state-level, full pipeline)

The strongest data source — PDFs download inline (via
`page.context.request.get` against the session-bound href) and feed
Claude Haiku 4.5 for structured extraction.

```json
{
  "id": "caleprocure-a3b2c1d4e5f6",
  "source_id": "caleprocure",
  "source_event_id": "3600/0000037948",
  "source_url": "https://caleprocure.ca.gov/...",
  "status": "open",
  "title": "Janitorial Services for Department of General Services",
  "description": "The Department of General Services seeks janitorial...",
  "agency": "Department of General Services",
  "procurement_type": "RFP",
  "posted_date": "2026-04-15",
  "deadline": "2026-05-30",
  "contact": {
    "name": "Jane Procurement",
    "email": "jane.p@dgs.ca.gov",
    "phone": "916-555-0100"
  },
  "attachment_urls": [
    "https://caleprocure.ca.gov/.../RFP_3600-37948.pdf",
    "https://caleprocure.ca.gov/.../Attachment_A_Spec.pdf"
  ],
  "industry": "Facilities Maintenance",
  "capabilities": ["Janitorial & Cleaning"],
  "location": "Sacramento, CA",
  "estimated_value": "$2.4M",

  // LLM-extracted (the "win" of inline PDF access)
  "naics_codes": ["561720"],
  "certifications": ["DBE", "Small Business (SB)", "DIR Registration"],
  "licenses_required": ["California Contractor License"],
  "clearances_required": ["DOJ Live Scan"],
  "set_aside_types": ["Small Business"],
  "deliverables": ["Daily janitorial services", "Quarterly deep clean"],
  "evaluation_criteria": ["Cost (40%)", "Experience (30%)", "References (30%)"],
  "contract_duration": "36 months with 2 one-year options",
  "incumbent_vendor": "ABC Cleaning Services Inc.",
  "incumbent_contract_end": "2026-06-30",

  "attachment_rollup": {
    "summary": "Janitorial services for state office buildings...",
    "text": "...",
    "pdfsProcessed": ["RFP_3600-37948.pdf", "Attachment_A_Spec.pdf"]
  },

  // Market intel — empty (Cal eProcure doesn't have these tabs)
  "prospective_bidders": [],
  "bid_results": [],
  "award": null
}
```

### PlanetBids (open bid, with vendor login)

Strong on market intel, weak on requirements (PDFs gated).

```json
{
  "id": "planetbids_san_diego-123abc456def",
  "source_id": "planetbids_san_diego",
  "source_event_id": "139554",
  "source_url": "https://vendors.planetbids.com/portal/17950/bo/bo-detail/139554",
  "status": "open",
  "title": "Janitorial Services 10090204-26-E",
  "description": "City of San Diego seeks janitorial services contractor...",
  "agency": "City of San Diego",
  "procurement_type": "Bid",
  "deadline": "04/29/2026",
  "contact": {
    "name": "Maria Buyer",
    "email": "mbuyer@sandiego.gov",
    "phone": "619-555-0100"
  },

  // attachment_urls is empty — Documents tab gated behind per-agency registration
  "attachment_urls": [],

  "industry": "Facilities Maintenance",
  "capabilities": ["Janitorial & Cleaning"],
  "location": "San Diego, CA",
  "estimated_value": "TBD",

  // LLM extraction empty — no PDFs accessible
  "naics_codes": [],
  "certifications": [],
  "licenses_required": [],
  "clearances_required": [],
  "set_aside_types": [],
  "deliverables": [],
  "evaluation_criteria": [],
  "contract_duration": null,
  "incumbent_vendor": null,
  "incumbent_contract_end": null,
  "attachment_rollup": null,

  // The "win" of PlanetBids — market intel
  "prospective_bidders": [
    {
      "vendor": {
        "name": "3H & 3H Inc.",
        "address": "P.O. Box 247",
        "city": "Buford",
        "state": "Georgia",
        "zip_code": "30515",
        "contact_name": "Kristina Woo",
        "phone": "404-820-8338",
        "email_redacted": "k**********o@3h3h.net",
        "certifications": ["MBE", "Asian", "DTSg"],
        "fingerprint": null
      },
      "classification": "Bidder",
      "pre_bid_attendee": false
    }
    // ... 121 more prospective bidders
  ],

  "bid_results": [],   // empty — bid still open
  "award": null         // empty — no award yet
}
```

### PlanetBids (awarded bid, --include-awarded)

Adds bid_results and award.

```json
{
  "id": "planetbids_san_diego-789xyz...",
  "source_id": "planetbids_san_diego",
  "source_event_id": "138240",
  "source_url": "https://vendors.planetbids.com/portal/17950/bo/bo-detail/138240",
  "status": "open",  // note: "Awarded" status events are still tracked as OPEN until removed from the listing
  "title": "Sunset Cliffs Devonshire Series Circuit Upgrade K-26-2468-DBB-3",
  "agency": "City of San Diego",
  "deadline": "...",

  // Same RFP-requirements pattern: empty, since PDFs gated
  "naics_codes": [],
  "licenses_required": [],
  "certifications": [],

  // Market intel — populated
  "prospective_bidders": [/* 26 entries */],

  "bid_results": [
    {
      "vendor": {
        "name": "Select Electric, Inc.",
        "address": "1700 E. Via Burton",
        "city": "Anaheim",
        "state": "California",
        "zip_code": "92806",
        "contact_name": "Landon Smith",
        "phone": "619-460-6060",
        "certifications": ["MBE", "MALE", "LAT", "CADIR"]
      },
      "amount_cents": 119065000,
      "amount_display": "$1,190,650.00",
      "responsive": false
    },
    {
      "vendor": { "name": "HMS Construction", "city": "Vista", /* ... */ },
      "amount_cents": 127500000,
      "amount_display": "$1,275,000.00",
      "responsive": true
    }
    // ...
  ],

  "award": {
    "vendor": null,                    // not yet structurally extracted
    "amount_cents": null,              // populated when finalized
    "amount_display": null,
    "awarded_date": null,
    "raw_text": "Award information has not been made public..." // or actual award text
  }
}
```

### BidSync / Periscope

The thinnest source — search-result metadata only.

```json
{
  "id": "bidsync_long_beach-...",
  "source_id": "bidsync_all_ca",
  "source_event_id": "BID-2026-00123",
  "source_url": "https://www.bidnetdirect.com/...",
  "status": "open",
  "title": "City Hall HVAC Replacement",
  "agency": "City of Long Beach",
  "deadline": "05/15/2026",
  "posted_date": null,            // not in the search results table
  "procurement_type": "",         // not extracted
  "description": "",              // detail page requires login
  "contact": { "name": null, "email": null, "phone": null },

  // Inferred from title only
  "industry": "Facilities Maintenance",
  "capabilities": ["HVAC Services"],
  "location": "Long Beach, CA",
  "estimated_value": "TBD",

  // Everything below is empty
  "attachment_urls": [],
  "naics_codes": [], "certifications": [], "licenses_required": [],
  "prospective_bidders": [], "bid_results": [], "award": null
}
```

### OpenGov (Pasadena and beyond)

Fully active via the direct JSON API. The customer-facing portal at
`procurement.opengov.com` is fronted by Cloudflare, but
`api.procurement.opengov.com` is wide open: no challenge, no auth.
Two-step scrape:

1. `POST /api/v1/government/{slug}/project/public` returns
   `{count, rows[]}` — each row has `id`, `financialId`, `title`,
   `summary`, `status`, `proposalDeadline`, `releaseProjectDate`,
   `department`, `government`. The orchestrator's
   `batch_offset`/`batch_size` map to the API's `page`/`limit`.

2. `GET /api/v1/project/{id}` per row returns the full project (~149
   keys) including `attachments[]` (each with a public S3 download
   `url`) and the flat contact field set (`contactEmail`,
   `contactPhone`, `contactDisplayName`, etc.).

Attachment PDFs download with plain `requests.get` and feed into the
existing PyMuPDF + Claude Haiku enrichment pipeline. ScrapingBee is
not in the OpenGov path.

### Agentic (LA City, SF City)

Disabled in the registry. LA's `labavn.org` DNS-fails on Lambda; SF's
contracting opportunities URL is a 404. Re-onboard via the agentic
onboarding pipeline once the Cloudflare situation is resolved or
alternate URLs are confirmed.

## Why fields are empty

| Reason | Affected | Possible unblock |
|---|---|---|
| **PlanetBids gated docs require per-bid Prospective Bidder registration** | `public_documents` (for `*`-marked rows), `attachment_urls`, all LLM-extracted fields, `attachment_rollup` for all PlanetBids events | Per-agency vendor registration alone does NOT unlock private docs — clicking "Download" opens a "Become a Prospective Bidder" modal for each bid. Automating PB-status is a ToS / disclosure issue (Civitas would appear in every bid's prospective_bidders tab). Pragmatic answer: live with PlanetBids = market-intel-only and rely on Cal eProcure for LLM-extracted RFP fields. |
| **BidSync detail pages require login** | `description`, `contact`, `attachment_urls` and downstream LLM fields for all BidSync events | Investigate vendor-account creation; or ToS questions; or skip in favour of agency-direct sources |
| **Agentic scrapers disabled** | All fields for LA City, SF City | Re-onboard via discovery + onboarding pipeline |
| **Source doesn't expose the data** (Cal eProcure has no Prospective Bidders tab) | `prospective_bidders`, `bid_results`, `award` for Cal eProcure | Not unblock-able; intrinsic to the source |

## Implications for matching

Match scoring should treat empty fields as **unknown, not zero**. Examples:

- A Cal eProcure RFP with `licenses_required: ["CSLB Class A"]` should match contractors holding that license. A PlanetBids RFP with `licenses_required: []` should *not* be penalized — we just don't know.
- A PlanetBids RFP with `bid_results: [...prior winners...]` enables "vendor likely to win again" signals. A Cal eProcure RFP without these can't surface that signal.
- The matcher should be aware of which source an event came from and adjust signal weights accordingly — not assume parity across sources.
