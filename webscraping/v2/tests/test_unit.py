"""
Unit tests for the Civitas v2 scraping system.
Tests data models, normalization pipeline, merge logic, and utilities
without any network calls.
"""

import pytest
from datetime import datetime

# Models
from webscraping.v2.models import (
    RawScrapedEvent,
    EnrichedEvent,
    AttachmentExtraction,
    ContactInfo,
    EventStatus,
    SiteConfig,
    ScraperType,
    SourceManifest,
)

# Pipeline
from webscraping.v2.pipeline.normalize import (
    normalize_event,
    infer_industry,
    infer_capabilities,
    extract_location,
    extract_estimated_value,
)

# Utils
from webscraping.v2.utils import event_hash, make_event_id

# Runner (merge logic)
from webscraping.v2.orchestrator.runner import merge_events


# ============================================================================
# Utils tests
# ============================================================================

class TestUtils:
    def test_event_hash_deterministic(self):
        h1 = event_hash("caleprocure", "3600/0000037948")
        h2 = event_hash("caleprocure", "3600/0000037948")
        assert h1 == h2
        assert len(h1) == 12

    def test_event_hash_different_inputs(self):
        h1 = event_hash("caleprocure", "3600/0000037948")
        h2 = event_hash("caleprocure", "3600/0000037949")
        assert h1 != h2

    def test_make_event_id(self):
        eid = make_event_id("caleprocure", "3600/0000037948")
        assert eid.startswith("caleprocure-")
        assert len(eid) == len("caleprocure-") + 12

    def test_make_event_id_deterministic(self):
        eid1 = make_event_id("planetbids_san_diego", "BID-2024-001")
        eid2 = make_event_id("planetbids_san_diego", "BID-2024-001")
        assert eid1 == eid2


# ============================================================================
# Model validation tests
# ============================================================================

class TestModels:
    def test_raw_scraped_event_minimal(self):
        event = RawScrapedEvent(
            source_id="test",
            source_event_id="001",
            source_url="https://example.com/event/001",
            title="Test RFP",
        )
        assert event.source_id == "test"
        assert event.description == ""
        assert event.attachment_urls == []
        assert event.contact.name is None

    def test_raw_scraped_event_full(self):
        event = RawScrapedEvent(
            source_id="caleprocure",
            source_event_id="3600/001",
            source_url="https://caleprocure.ca.gov/event/3600/001",
            title="Office Cleaning Services",
            description="Janitorial services for state buildings",
            issuing_agency="Department of General Services",
            posted_date="01/15/2025",
            due_date="02/15/2025",
            contact=ContactInfo(name="Jane Doe", email="jane@ca.gov", phone="555-1234"),
            procurement_type="RFP",
            attachment_urls=["https://example.com/doc.pdf"],
            raw_metadata={"format": "RFP"},
        )
        assert event.contact.email == "jane@ca.gov"
        assert len(event.attachment_urls) == 1

    def test_raw_scraped_event_missing_required(self):
        with pytest.raises(Exception):
            RawScrapedEvent(source_id="test")  # missing required fields

    def test_enriched_event_defaults(self):
        event = EnrichedEvent(
            id="test-abc123def456",
            source_id="test",
            source_event_id="001",
            source_url="https://example.com",
            title="Test",
        )
        assert event.status == EventStatus.OPEN
        assert event.location == "California"
        assert event.estimated_value == "TBD"
        assert event.industry == "Government Services"
        assert event.naics_codes == []
        assert event.capabilities == []

    def test_attachment_extraction(self):
        ext = AttachmentExtraction(
            naics_codes=["561720", "561730"],
            certifications_required=["DBE", "SBE"],
            set_aside_types=["Small Business"],
            capabilities_required=["Janitorial", "Floor Care"],
            contract_value_estimate="$500,000",
            key_requirements_summary="Janitorial services for 5 buildings",
        )
        assert len(ext.naics_codes) == 2
        assert ext.contract_value_estimate == "$500,000"

    def test_site_config_defaults(self):
        config = SiteConfig(
            site_id="test",
            name="Test Site",
            url="https://example.com",
        )
        assert config.enabled is True
        assert config.scraper_type == ScraperType.STRUCTURED
        assert config.health_status.value == "healthy"

    def test_source_manifest(self):
        manifest = SourceManifest(
            source_id="test",
            source_name="Test",
            total_events=0,
        )
        assert manifest.events == []
        assert manifest.updated_at  # auto-generated


# ============================================================================
# Normalize pipeline tests
# ============================================================================

class TestNormalize:
    def _make_raw(self, **kwargs) -> RawScrapedEvent:
        defaults = {
            "source_id": "test",
            "source_event_id": "001",
            "source_url": "https://example.com",
            "title": "Test Event",
        }
        defaults.update(kwargs)
        return RawScrapedEvent(**defaults)

    def test_normalize_basic(self):
        raw = self._make_raw(
            title="Office Cleaning Services",
            issuing_agency="Department of General Services",
        )
        enriched = normalize_event(raw)
        assert enriched.id.startswith("test-")
        assert enriched.title == "Office Cleaning Services"
        assert enriched.agency == "Department of General Services"
        assert enriched.status == EventStatus.OPEN

    def test_normalize_with_extraction(self):
        raw = self._make_raw(title="IT Network Upgrade")
        extraction = AttachmentExtraction(
            naics_codes=["541512"],
            capabilities_required=["Network Infrastructure"],
            contract_value_estimate="$1,200,000",
            location_details=["Sacramento, CA"],
        )
        enriched = normalize_event(raw, extraction)
        assert enriched.naics_codes == ["541512"]
        assert enriched.estimated_value == "$1,200,000"
        assert enriched.location == "Sacramento, CA"

    def test_normalize_encoding_fix(self):
        raw = self._make_raw(title="Service \u00bf Maintenance")
        enriched = normalize_event(raw)
        assert "\u00bf" not in enriched.title
        assert "\u2013" in enriched.title


class TestInferIndustry:
    def test_construction(self):
        assert infer_industry("", "Highway Bridge Repair") == "Construction"

    def test_it_services(self):
        assert infer_industry("", "Cloud Migration Software") == "IT Services"

    def test_janitorial(self):
        assert infer_industry("", "Janitorial Cleaning Services") == "Facilities Maintenance"

    def test_environmental(self):
        assert infer_industry("", "Hazardous Waste Remediation") == "Environmental Services"

    def test_dept_fallback(self):
        assert infer_industry("Dept of Transportation", "Misc Services") == "Transportation"

    def test_default(self):
        assert infer_industry("", "General Administrative Work") == "Government Services"

    def test_cyber_not_security(self):
        """Cyber should map to IT, not Security."""
        result = infer_industry("", "Cybersecurity Assessment Services")
        assert result == "IT Services"


class TestInferCapabilities:
    def test_single_match(self):
        caps = infer_capabilities("HVAC Maintenance Contract", "", "Facilities Maintenance")
        assert "HVAC Services" in caps

    def test_multiple_matches(self):
        caps = infer_capabilities("Cloud Migration and Database Management", "", "IT Services")
        assert "Cloud Services" in caps
        assert "Database Management" in caps

    def test_fallback_to_industry(self):
        caps = infer_capabilities("General Services", "", "Construction")
        assert "Building Construction" in caps

    def test_no_duplicates(self):
        caps = infer_capabilities(
            "Cloud Cloud Cloud AWS AWS", "", "IT Services"
        )
        assert len(caps) == len(set(caps))


class TestExtractLocation:
    def test_city_ca_pattern(self):
        loc = extract_location("Project in Sacramento, CA 95814", "", "")
        assert "Sacramento" in loc

    def test_county_pattern(self):
        loc = extract_location("Orange County Bridge Replacement", "", "")
        assert "Orange County, CA" == loc

    def test_city_name_match(self):
        loc = extract_location("San Diego Highway Project", "", "")
        assert "San Diego" in loc

    def test_default_california(self):
        loc = extract_location("General Widget Procurement", "", "")
        assert loc == "California"

    def test_city_field_in_description(self):
        loc = extract_location("", "City: Fresno\nCounty: Fresno", "")
        assert "Fresno" in loc


class TestExtractEstimatedValue:
    def test_single_value(self):
        assert extract_estimated_value("Estimated cost $500,000") == "$500,000"

    def test_range(self):
        val = extract_estimated_value("Budget $100,000 - $200,000")
        assert "$100,000" in val

    def test_no_value(self):
        assert extract_estimated_value("No budget specified") == "TBD"


# ============================================================================
# Merge logic tests
# ============================================================================

class TestMergeEvents:
    def _make_enriched(self, eid: str, title: str = "Test") -> EnrichedEvent:
        return EnrichedEvent(
            id=eid,
            source_id="test",
            source_event_id=eid,
            source_url="https://example.com",
            title=title,
            status=EventStatus.OPEN,
            first_seen_at="2025-01-01T00:00:00",
            last_seen_at="2025-01-01T00:00:00",
        )

    def test_all_new_events(self):
        existing = {}
        fresh = [self._make_enriched("a"), self._make_enriched("b")]
        merged = merge_events(existing, fresh)
        assert len(merged) == 2
        assert all(e.status == EventStatus.OPEN for e in merged)

    def test_existing_updated(self):
        existing = {"a": self._make_enriched("a", "Old Title")}
        fresh = [self._make_enriched("a", "New Title")]
        merged = merge_events(existing, fresh)
        assert len(merged) == 1
        event = merged[0]
        assert event.title == "New Title"
        assert event.first_seen_at == "2025-01-01T00:00:00"  # preserved
        assert event.status == EventStatus.OPEN

    def test_missing_marked_closed(self):
        existing = {
            "a": self._make_enriched("a"),
            "b": self._make_enriched("b"),
        }
        fresh = [self._make_enriched("a")]
        merged = merge_events(existing, fresh)
        assert len(merged) == 2
        by_id = {e.id: e for e in merged}
        assert by_id["a"].status == EventStatus.OPEN
        assert by_id["b"].status == EventStatus.CLOSED
        assert by_id["b"].closed_at is not None

    def test_new_and_existing_combined(self):
        existing = {"a": self._make_enriched("a")}
        fresh = [self._make_enriched("a"), self._make_enriched("c")]
        merged = merge_events(existing, fresh)
        assert len(merged) == 2
        ids = {e.id for e in merged}
        assert ids == {"a", "c"}

    def test_empty_both(self):
        merged = merge_events({}, [])
        assert merged == []

    def test_already_closed_stays_closed(self):
        old = self._make_enriched("a")
        old.status = EventStatus.CLOSED
        old.closed_at = "2025-01-02T00:00:00"
        existing = {"a": old}
        fresh = []
        merged = merge_events(existing, fresh)
        assert len(merged) == 1
        assert merged[0].status == EventStatus.CLOSED
        assert merged[0].closed_at == "2025-01-02T00:00:00"  # preserved, not overwritten


# ============================================================================
# Site registry tests
# ============================================================================

class TestSiteRegistry:
    def test_registry_loads(self):
        from webscraping.v2.orchestrator.runner import SITE_REGISTRY
        assert len(SITE_REGISTRY) > 50  # 62 expected
        assert "caleprocure" in SITE_REGISTRY
        assert "la_city" in SITE_REGISTRY
        assert "sf_city" in SITE_REGISTRY

    def test_planetbids_sites_present(self):
        from webscraping.v2.orchestrator.runner import SITE_REGISTRY
        pb_sites = [k for k in SITE_REGISTRY if k.startswith("planetbids_")]
        assert len(pb_sites) >= 35

    def test_bidsync_sites_present(self):
        from webscraping.v2.orchestrator.runner import SITE_REGISTRY
        bs_sites = [k for k in SITE_REGISTRY if k.startswith("bidsync_")]
        assert len(bs_sites) >= 10

    def test_scraper_factory(self):
        from webscraping.v2.orchestrator.runner import SITE_REGISTRY, get_scraper
        from webscraping.v2.scrapers.caleprocure import CalEprocureScraper
        from webscraping.v2.scrapers.planetbids import PlanetBidsScraper
        from webscraping.v2.scrapers.bidsync import BidSyncScraper

        scraper = get_scraper(SITE_REGISTRY["caleprocure"])
        assert isinstance(scraper, CalEprocureScraper)

        scraper = get_scraper(SITE_REGISTRY["planetbids_san_diego"])
        assert isinstance(scraper, PlanetBidsScraper)

        scraper = get_scraper(SITE_REGISTRY["bidsync_all_ca"])
        assert isinstance(scraper, BidSyncScraper)


# ============================================================================
# BidSync agency matching tests
# ============================================================================

class TestBidSyncAgencyMatching:
    def test_exact_match(self):
        from webscraping.v2.scrapers.bidsync import _match_agency
        site_id, name = _match_agency("City of Long Beach")
        assert site_id == "bidsync_long_beach"

    def test_substring_match(self):
        from webscraping.v2.scrapers.bidsync import _match_agency
        site_id, name = _match_agency("County of Orange - Purchasing")
        assert site_id == "bidsync_orange_county"

    def test_unknown_agency(self):
        from webscraping.v2.scrapers.bidsync import _match_agency
        site_id, name = _match_agency("City of Unknown Town")
        assert site_id.startswith("bidsync_")
        assert "unknown" in site_id.lower()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
