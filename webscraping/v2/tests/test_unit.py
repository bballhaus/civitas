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


# ============================================================================
# Market intel: parser helpers
# ============================================================================

class TestPlanetBidsParsers:
    def test_parse_currency(self):
        from webscraping.v2.scrapers.planetbids_parsers import parse_currency
        assert parse_currency("$1,190,650.00") == 119065000
        assert parse_currency("$0.00") == 0
        assert parse_currency("$2.50") == 250
        assert parse_currency("Total: $42,000") == 4200000  # no cents
        assert parse_currency("") is None
        assert parse_currency(None) is None
        assert parse_currency("N/A") is None

    def test_parse_responsive(self):
        from webscraping.v2.scrapers.planetbids_parsers import parse_responsive
        assert parse_responsive("Yes") is True
        assert parse_responsive("yes") is True
        assert parse_responsive("No") is False
        assert parse_responsive("NO") is False
        assert parse_responsive("Non-Responsive") is False
        assert parse_responsive("") is None
        assert parse_responsive(None) is None
        assert parse_responsive("maybe") is None

    def test_parse_certifications(self):
        from webscraping.v2.scrapers.planetbids_parsers import parse_certifications
        assert parse_certifications("MBE, WBE, DBE, CADIR") == ["MBE", "WBE", "DBE", "CADIR"]
        assert parse_certifications("Local") == ["Local"]
        assert parse_certifications("") == []
        assert parse_certifications(None) == []
        # Drops absurdly long tokens (probably not certs)
        assert "verylongtokenherethatsnotacert" not in parse_certifications(
            "MBE, verylongtokenherethatsnotacert, DBE"
        )

    def test_parse_vendor_block_full(self):
        from webscraping.v2.scrapers.planetbids_parsers import parse_vendor_block
        v = parse_vendor_block(
            "Select Electric, Inc.\n"
            "1700 E. Via Burton\n"
            "Anaheim, California 92806\n"
            "Contact: Landon Smith\n"
            "Phone: 619-460-6060"
        )
        assert v.name == "Select Electric, Inc."
        assert v.address == "1700 E. Via Burton"
        assert v.city == "Anaheim"
        assert v.state == "California"
        assert v.zip_code == "92806"
        assert v.contact_name == "Landon Smith"
        assert v.phone == "619-460-6060"
        # Certifications come from a separate cell, not the vendor block
        assert v.certifications == []

    def test_parse_vendor_block_skips_fax_keeps_email(self):
        from webscraping.v2.scrapers.planetbids_parsers import parse_vendor_block
        v = parse_vendor_block(
            "AGC San Diego\n"
            "10140 Riverford Rd. Plan Room\n"
            "Lakeside, California 92040\n"
            "Contact: Scherrise Judge\n"
            "Phone: 858-558-7444\n"
            "Fax: 858-558-8444\n"
            "p******m@agcsd.org"
        )
        assert v.name == "AGC San Diego"
        assert v.phone == "858-558-7444"  # not Fax
        assert v.email_redacted == "p******m@agcsd.org"
        assert v.zip_code == "92040"

    def test_parse_vendor_block_empty(self):
        from webscraping.v2.scrapers.planetbids_parsers import parse_vendor_block
        assert parse_vendor_block("") is None
        assert parse_vendor_block(None) is None
        assert parse_vendor_block("   \n  ") is None


# ============================================================================
# Market intel: model round-trip
# ============================================================================

class TestMarketIntelModels:
    def test_vendor_round_trip(self):
        from webscraping.v2.models import Vendor
        v = Vendor(
            name="Select Electric, Inc.",
            city="Anaheim",
            state="California",
            zip_code="92806",
            certifications=["MBE", "CADIR"],
        )
        json_str = v.model_dump_json()
        v2 = Vendor.model_validate_json(json_str)
        assert v2.name == v.name
        assert v2.certifications == v.certifications

    def test_bid_result_round_trip(self):
        from webscraping.v2.models import Vendor, BidResult
        br = BidResult(
            vendor=Vendor(name="HMS Construction"),
            amount_cents=127500000,
            amount_display="$1,275,000.00",
            responsive=True,
        )
        br2 = BidResult.model_validate_json(br.model_dump_json())
        assert br2.amount_cents == 127500000
        assert br2.responsive is True
        assert br2.vendor.name == "HMS Construction"

    def test_enriched_event_with_market_intel(self):
        from webscraping.v2.models import (
            EnrichedEvent, Vendor, ProspectiveBidder, BidResult, Award,
        )
        v = Vendor(name="Acme Corp")
        e = EnrichedEvent(
            id="x",
            source_id="planetbids_san_diego",
            source_event_id="139554",
            source_url="https://example.com",
            title="Test",
            prospective_bidders=[ProspectiveBidder(vendor=v, classification="Bidder")],
            bid_results=[BidResult(vendor=v, amount_cents=100000)],
            award=Award(vendor=v, amount_cents=100000),
        )
        # Round-trip through JSON preserves nested structure
        e2 = EnrichedEvent.model_validate_json(e.model_dump_json())
        assert len(e2.prospective_bidders) == 1
        assert e2.prospective_bidders[0].vendor.name == "Acme Corp"
        assert e2.bid_results[0].amount_cents == 100000
        assert e2.award.amount_cents == 100000


# ============================================================================
# Merge: historical market-intel preservation
# ============================================================================

class TestMergePreservesMarketIntel:
    def _enriched_with_intel(
        self, eid: str, has_intel: bool = False
    ) -> EnrichedEvent:
        from webscraping.v2.models import Vendor, BidResult, Award
        e = EnrichedEvent(
            id=eid,
            source_id="planetbids_san_diego",
            source_event_id=eid,
            source_url="https://example.com",
            title="Test",
            status=EventStatus.OPEN,
        )
        if has_intel:
            v = Vendor(name="Past Bidder")
            e.bid_results = [BidResult(vendor=v, amount_cents=42_000_00)]
            e.award = Award(vendor=v, amount_cents=42_000_00)
        return e

    def test_existing_intel_preserved_when_fresh_lacks_it(self):
        """A re-scrape that doesn't capture bid_results/award should not
        clobber data captured by a previous --include-awarded run."""
        existing = {"a": self._enriched_with_intel("a", has_intel=True)}
        fresh = [self._enriched_with_intel("a", has_intel=False)]
        merged = merge_events(existing, fresh)
        assert len(merged) == 1
        assert len(merged[0].bid_results) == 1
        assert merged[0].bid_results[0].amount_cents == 4_200_000
        assert merged[0].award is not None

    def test_fresh_intel_overrides_existing(self):
        from webscraping.v2.models import Vendor, BidResult
        existing = {"a": self._enriched_with_intel("a", has_intel=True)}
        fresh_event = self._enriched_with_intel("a", has_intel=False)
        fresh_event.bid_results = [
            BidResult(vendor=Vendor(name="New Bidder"), amount_cents=500_000_00)
        ]
        merged = merge_events(existing, [fresh_event])
        assert merged[0].bid_results[0].vendor.name == "New Bidder"
        assert merged[0].bid_results[0].amount_cents == 50_000_000


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
