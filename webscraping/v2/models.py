"""
Pydantic models for the Civitas v2 scraping system.

These define the data contracts between scraper tiers, the processing pipeline,
and the frontend. All scrapers produce RawScrapedEvent; the pipeline enriches
them into EnrichedEvent which maps directly to the frontend RFP interface.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class ScraperType(str, Enum):
    API = "api"
    STRUCTURED = "structured"
    AGENTIC = "agentic"


class SiteHealthStatus(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    DOWN = "down"
    NEEDS_REVIEW = "needs_review"


# ---------------------------------------------------------------------------
# Contact info (shared across models)
# ---------------------------------------------------------------------------

class ContactInfo(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None


# ---------------------------------------------------------------------------
# Raw scraped event — what every scraper produces
# ---------------------------------------------------------------------------

class RawScrapedEvent(BaseModel):
    """Output of any scraper tier. Minimal required fields + optional extras."""
    source_id: str = Field(..., description="Site registry key, e.g. 'caleprocure'")
    source_event_id: str = Field(..., description="ID on the source site, e.g. '3600/0000037948'")
    source_url: str = Field(..., description="Direct URL to the event on the source site")
    title: str
    description: str = ""
    issuing_agency: str = ""
    posted_date: Optional[str] = None
    due_date: Optional[str] = None
    contact: ContactInfo = Field(default_factory=ContactInfo)
    procurement_type: str = ""  # RFP, RFQ, IFB, etc.
    attachment_urls: list[str] = Field(default_factory=list)
    raw_metadata: dict = Field(default_factory=dict, description="Source-specific extra fields")
    scraped_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())

    # Market intel — populated by sources that expose it (PlanetBids today)
    prospective_bidders: list["ProspectiveBidder"] = Field(default_factory=list)
    bid_results: list["BidResult"] = Field(default_factory=list)
    award: Optional["Award"] = None


# ---------------------------------------------------------------------------
# Attachment extraction — LLM-derived metadata from PDFs
# ---------------------------------------------------------------------------

class AttachmentExtraction(BaseModel):
    """Structured metadata extracted from RFP attachment PDFs via LLM."""
    naics_codes: list[str] = Field(default_factory=list)
    certifications_required: list[str] = Field(
        default_factory=list,
        description="Programs / status certs / registrations (DBE, MBE, WBE, SBE, DIR, SOC2, ISO). NOT trade licenses."
    )
    licenses_required: list[str] = Field(
        default_factory=list,
        description="Trade/professional licenses (CSLB Class A, C-10 Electrical, PE License, Architect License)."
    )
    incumbent_vendor: Optional[str] = Field(
        default=None,
        description="Current contractor named in the RFP, if mentioned."
    )
    incumbent_contract_end: Optional[str] = Field(
        default=None,
        description="Date the incumbent's current contract expires, if mentioned."
    )
    clearances_required: list[str] = Field(default_factory=list)
    set_aside_types: list[str] = Field(default_factory=list)
    capabilities_required: list[str] = Field(default_factory=list)
    contract_value_estimate: Optional[str] = None
    contract_duration: Optional[str] = None
    location_details: list[str] = Field(default_factory=list)
    onsite_required: Optional[bool] = None
    key_requirements_summary: str = "Unknown"
    deliverables: list[str] = Field(default_factory=list)
    evaluation_criteria: list[str] = Field(default_factory=list)
    attachment_text_rollup: str = ""
    pdfs_processed: list[str] = Field(default_factory=list)
    total_pdfs_available: int = 0


# ---------------------------------------------------------------------------
# Vendor / bid / award — market-intel data scraped from PlanetBids detail tabs
# ---------------------------------------------------------------------------

class Vendor(BaseModel):
    """A bidder or potential bidder on an RFP.

    Identity resolution (deduping the same company across events) is a
    post-process pass that builds a vendors/index.json keyed by fingerprint.
    `fingerprint` is computed at that time, not at scrape time.
    """
    name: str
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    contact_name: Optional[str] = None
    phone: Optional[str] = None
    email_redacted: Optional[str] = Field(
        default=None,
        description="PlanetBids partially redacts emails (e.g. 'k**********o@3h3h.net')"
    )
    certifications: list[str] = Field(
        default_factory=list,
        description="What the vendor holds: MBE, WBE, DBE, SDB, CADIR, Local, etc."
    )
    fingerprint: Optional[str] = Field(
        default=None,
        description="Stable cross-event dedup key, populated by the vendor index post-process"
    )


class ProspectiveBidder(BaseModel):
    """A vendor that registered interest before the bid closed."""
    vendor: Vendor
    pre_bid_attendee: Optional[bool] = None
    classification: Optional[str] = Field(
        default=None,
        description="'Bidder', 'Subcontractor', 'Plan Room', etc."
    )


class BidResult(BaseModel):
    """A submitted bid on a closed event."""
    vendor: Vendor
    amount_cents: Optional[int] = Field(
        default=None,
        description="Bid amount in cents, e.g. 119065000 for $1,190,650.00. Cents avoids float rounding."
    )
    amount_display: Optional[str] = Field(
        default=None,
        description="As shown on the page, e.g. '$1,190,650.00'. Preserved for explainability."
    )
    responsive: Optional[bool] = Field(
        default=None,
        description="Whether the bid was deemed responsive to the solicitation requirements."
    )


class Award(BaseModel):
    """The selected winning bid for an event."""
    vendor: Optional[Vendor] = None
    amount_cents: Optional[int] = None
    amount_display: Optional[str] = None
    awarded_date: Optional[str] = None
    raw_text: Optional[str] = Field(
        default=None,
        description="Snippet from the Awards tab — preserved verbatim for explainability."
    )


# ---------------------------------------------------------------------------
# Enriched event — fully processed, ready for frontend/matching
# ---------------------------------------------------------------------------

class EventStatus(str, Enum):
    OPEN = "open"
    CLOSED = "closed"


class EnrichedEvent(BaseModel):
    """Final output after the full pipeline. Maps to the frontend RFP interface."""
    # Identity
    id: str = Field(..., description="Deterministic ID: {source_id}-{hash(source_event_id)}")
    source_id: str
    source_event_id: str
    source_url: str

    # Status tracking
    status: EventStatus = EventStatus.OPEN
    first_seen_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    last_seen_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    closed_at: Optional[str] = None

    # Core fields
    title: str
    description: str = ""
    agency: str = ""
    location: str = "California"
    deadline: str = ""
    estimated_value: str = "TBD"
    industry: str = "Government Services"
    procurement_type: str = ""

    # Matching fields
    naics_codes: list[str] = Field(default_factory=list)
    capabilities: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(
        default_factory=list,
        description="Certs/programs the RFP requires of bidders (e.g. DBE, DIR registration). NOT trade licenses."
    )
    licenses_required: list[str] = Field(
        default_factory=list,
        description="Trade/professional licenses the RFP requires (e.g. CSLB Class A, C-10 Electrical)."
    )

    # Contact
    contact: ContactInfo = Field(default_factory=ContactInfo)

    # Attachments
    attachment_urls: list[str] = Field(default_factory=list, description="Direct download URLs for RFP documents")

    # Attachment-derived (from LLM enrichment)
    clearances_required: list[str] = Field(default_factory=list)
    set_aside_types: list[str] = Field(default_factory=list)
    deliverables: list[str] = Field(default_factory=list)
    contract_duration: Optional[str] = None
    evaluation_criteria: list[str] = Field(default_factory=list)
    attachment_rollup: Optional[dict] = None

    # Metadata
    posted_date: Optional[str] = None
    scraped_at: str = ""

    # Market intel (PlanetBids detail tabs — empty on sources that don't expose this)
    prospective_bidders: list[ProspectiveBidder] = Field(default_factory=list)
    bid_results: list[BidResult] = Field(default_factory=list)
    award: Optional[Award] = None
    incumbent_vendor: Optional[str] = Field(
        default=None,
        description="Current contractor named in the RFP description/PDFs (LLM-extracted, future)"
    )
    incumbent_contract_end: Optional[str] = None


# ---------------------------------------------------------------------------
# Site configuration — registry entry for a procurement site
# ---------------------------------------------------------------------------

class SiteConfig(BaseModel):
    """Configuration for a single procurement site in the registry."""
    site_id: str = Field(..., description="Unique key, e.g. 'caleprocure'")
    name: str = Field(..., description="Human-readable name")
    url: str = Field(..., description="Base URL for the site")
    scraper_type: ScraperType = ScraperType.STRUCTURED
    schedule_cron: str = "0 */4 * * *"  # default: every 4 hours
    enabled: bool = True
    priority: int = 1  # 1=highest
    min_request_interval_ms: int = 3000
    health_status: SiteHealthStatus = SiteHealthStatus.HEALTHY
    last_run: Optional[str] = None
    last_success: Optional[str] = None
    events_found_last_run: int = 0
    config: dict = Field(default_factory=dict, description="Scraper-specific config (selectors, API params, etc.)")
    cached_recipe: Optional[dict] = None  # For agentic scrapers


# ---------------------------------------------------------------------------
# Scraper recipe — cached auto-generated extraction config
# ---------------------------------------------------------------------------

class ScraperRecipe(BaseModel):
    """Auto-generated by the agentic scraper. Cached for subsequent runs."""
    site_id: str
    generated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    listing_url: str = Field(..., description="URL of the page with RFP listings")
    listing_selector: str = Field(..., description="CSS selector for individual RFP rows/cards")
    fields: dict[str, dict] = Field(
        ...,
        description="Map of field name -> {selector, attribute} for extracting data from each row"
    )
    pagination: Optional[dict] = Field(
        None,
        description="Pagination config: {type: 'next_button'|'load_more'|'page_numbers', selector: '...'}"
    )
    detail_page: Optional[dict] = Field(
        None,
        description="If detail pages exist: {link_selector, fields: {name: {selector, attribute}}}"
    )
    validation_count: int = Field(0, description="Number of events successfully extracted with this recipe")


# ---------------------------------------------------------------------------
# Manifest — index of all events for a source
# ---------------------------------------------------------------------------

class SourceManifest(BaseModel):
    """Per-source index stored at scrapes/v2/manifests/{source_id}/latest.json"""
    source_id: str
    source_name: str
    updated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    total_events: int = 0
    events: list[EnrichedEvent] = Field(default_factory=list)
