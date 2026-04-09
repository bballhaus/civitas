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


# ---------------------------------------------------------------------------
# Attachment extraction — LLM-derived metadata from PDFs
# ---------------------------------------------------------------------------

class AttachmentExtraction(BaseModel):
    """Structured metadata extracted from RFP attachment PDFs via LLM."""
    naics_codes: list[str] = Field(default_factory=list)
    certifications_required: list[str] = Field(default_factory=list)
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
# Enriched event — fully processed, ready for frontend/matching
# ---------------------------------------------------------------------------

class EnrichedEvent(BaseModel):
    """Final output after the full pipeline. Maps to the frontend RFP interface."""
    # Identity
    id: str = Field(..., description="Deterministic ID: {source_id}-{hash(source_event_id)}")
    source_id: str
    source_event_id: str
    source_url: str

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
    certifications: list[str] = Field(default_factory=list)

    # Contact
    contact: ContactInfo = Field(default_factory=ContactInfo)

    # Attachment-derived
    clearances_required: list[str] = Field(default_factory=list)
    set_aside_types: list[str] = Field(default_factory=list)
    deliverables: list[str] = Field(default_factory=list)
    contract_duration: Optional[str] = None
    evaluation_criteria: list[str] = Field(default_factory=list)
    attachment_rollup: Optional[dict] = None

    # Metadata
    posted_date: Optional[str] = None
    scraped_at: str = ""


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
