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

    def test_extraction_separates_certs_from_licenses(self):
        ext = AttachmentExtraction(
            certifications_required=["DBE", "DIR Registration"],
            licenses_required=["CSLB Class A General Contractor", "C-10 Electrical"],
        )
        assert "DBE" in ext.certifications_required
        assert "CSLB Class A General Contractor" in ext.licenses_required
        # The two lists do not bleed into each other
        assert "CSLB Class A General Contractor" not in ext.certifications_required
        assert "DBE" not in ext.licenses_required

    def test_enriched_event_has_licenses_field(self):
        e = EnrichedEvent(
            id="x", source_id="s", source_event_id="e",
            source_url="https://x", title="t",
            certifications=["DBE"],
            licenses_required=["CSLB Class A General Contractor"],
        )
        # Round-trip preserves both
        e2 = EnrichedEvent.model_validate_json(e.model_dump_json())
        assert e2.certifications == ["DBE"]
        assert e2.licenses_required == ["CSLB Class A General Contractor"]

    def test_extraction_carries_incumbent_fields(self):
        ext = AttachmentExtraction(
            incumbent_vendor="ABC Cleaning Services Inc.",
            incumbent_contract_end="2026-06-30",
        )
        assert ext.incumbent_vendor == "ABC Cleaning Services Inc."
        assert ext.incumbent_contract_end == "2026-06-30"

    def test_normalize_passes_incumbent_through(self):
        ext = AttachmentExtraction(
            incumbent_vendor="ABC Cleaning Services Inc.",
            incumbent_contract_end="2026-06-30",
        )
        raw = RawScrapedEvent(
            source_id="caleprocure",
            source_event_id="3600/0000037948",
            source_url="https://example.com",
            title="Test",
        )
        enriched = normalize_event(raw, extraction=ext)
        assert enriched.incumbent_vendor == "ABC Cleaning Services Inc."
        assert enriched.incumbent_contract_end == "2026-06-30"

    def test_normalize_incumbent_none_when_no_extraction(self):
        raw = RawScrapedEvent(
            source_id="planetbids_san_diego",
            source_event_id="139554",
            source_url="https://example.com",
            title="Test",
        )
        enriched = normalize_event(raw, extraction=None)
        assert enriched.incumbent_vendor is None
        assert enriched.incumbent_contract_end is None


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


# ============================================================================
# PlanetBids pagination
# ============================================================================

class TestPlanetBidsPagination:
    def test_default_no_pagination(self):
        from webscraping.v2.scrapers.planetbids import PlanetBidsScraper, get_planetbids_site_configs
        cfg = get_planetbids_site_configs()["planetbids_san_diego"]
        s = PlanetBidsScraper(cfg)
        assert s.batch_offset == 0
        assert s.batch_size is None
        assert s.total_available == 0

    def test_paginated_init(self):
        from webscraping.v2.scrapers.planetbids import PlanetBidsScraper, get_planetbids_site_configs
        cfg = get_planetbids_site_configs()["planetbids_san_diego"]
        s = PlanetBidsScraper(cfg, batch_offset=8, batch_size=8)
        assert s.batch_offset == 8
        assert s.batch_size == 8

    def test_run_site_batch_routes_planetbids(self):
        # Verifies the orchestrator factory branches PlanetBids through pagination
        # without actually running a scrape. Uses inspect to confirm the constructor
        # is called with batch params.
        import inspect
        from webscraping.v2.orchestrator import runner
        src = inspect.getsource(runner.run_site_batch)
        assert "planetbids_" in src
        assert "PlanetBidsScraper" in src
        assert "batch_offset=batch_offset" in src
        assert "batch_size=batch_size" in src


# ============================================================================
# OpenGov API client tests (no network — fake requests via monkeypatch)
# ============================================================================

class TestOpenGovApiClient:
    def _scraper(self, **kwargs):
        from webscraping.v2.scrapers.opengov import OpenGovScraper
        cfg = SiteConfig(
            site_id="opengov_pasadena",
            name="City of Pasadena",
            url="https://procurement.opengov.com/portal/pasadena",
            scraper_type=ScraperType.STRUCTURED,
            config={
                "slug": "pasadena",
                "name": "City of Pasadena",
                "url": "https://procurement.opengov.com/portal/pasadena",
            },
        )
        return OpenGovScraper(cfg, **kwargs)

    def test_extract_procurement_type(self):
        from webscraping.v2.scrapers.opengov import _extract_procurement_type
        assert _extract_procurement_type("2026-RFP-0123") == "RFP"
        assert _extract_procurement_type("RFB-2026-007") == "RFB"
        assert _extract_procurement_type("2026-IFB-CIV-0216") == "IFB"
        assert _extract_procurement_type("RFQ-001") == "RFQ"
        # Unknown shape falls back to RFP.
        assert _extract_procurement_type("some-random-id") == "RFP"
        assert _extract_procurement_type("") == "RFP"

    def test_extract_contact_prefers_display_name(self):
        from webscraping.v2.scrapers.opengov import _extract_contact
        c = _extract_contact({
            "contactDisplayName": "Jane Doe",
            "contactFirstName": "Janet",
            "contactLastName": "Smith",
            "contactEmail": "jane@example.gov",
            "contactPhoneComplete": "(626) 555-0100 ext 42",
            "contactPhone": "626-555-0100",
        })
        assert c.name == "Jane Doe"
        assert c.email == "jane@example.gov"
        assert c.phone == "(626) 555-0100 ext 42"

    def test_extract_contact_falls_back_to_first_last(self):
        from webscraping.v2.scrapers.opengov import _extract_contact
        c = _extract_contact({
            "contactFirstName": "Janet",
            "contactLastName": "Smith",
            "contactEmail": "",
            "contactPhone": "626-555-0100",
        })
        assert c.name == "Janet Smith"
        assert c.email is None
        assert c.phone == "626-555-0100"

    def test_extract_contact_all_blank(self):
        from webscraping.v2.scrapers.opengov import _extract_contact
        c = _extract_contact({})
        assert c.name is None
        assert c.email is None
        assert c.phone is None

    def test_strip_html_handles_tags_and_entities(self):
        from webscraping.v2.scrapers.opengov import _strip_html
        html = "<p>Hello&nbsp;<b>world</b> &amp; goodbye</p>"
        assert _strip_html(html) == "Hello world & goodbye"
        assert _strip_html("") == ""

    def test_build_event_from_detail(self):
        s = self._scraper()
        detail = {
            "id": 232604,
            "title": "Design-Build Services for a Hydrogen Fueling Station",
            "financialId": "2026-RFP-0123",
            "summary": "<p>Full RFP description.</p>",
            "status": "open",
            "releaseProjectDate": "2026-04-08T22:25:33.381Z",
            "proposalDeadline": "2026-06-08T21:00:54.486Z",
            "government": {
                "code": "pasadena",
                "organization": {"name": "City of Pasadena", "id": 530},
            },
            "department": {"id": 5, "name": "Public Works"},
            "contactDisplayName": "Jane Doe",
            "contactEmail": "jane@cityofpasadena.net",
            "contactPhone": "626-555-0100",
        }
        ev = s._build_event(detail, listing_row={"id": 232604})
        assert ev is not None
        assert ev.source_event_id == "2026-RFP-0123"
        assert ev.source_url == "https://procurement.opengov.com/portal/pasadena/projects/232604"
        assert ev.title == detail["title"]
        assert ev.description == "Full RFP description."
        assert ev.issuing_agency == "City of Pasadena"
        assert ev.posted_date == detail["releaseProjectDate"]
        assert ev.due_date == detail["proposalDeadline"]
        assert ev.procurement_type == "RFP"
        assert ev.contact.email == "jane@cityofpasadena.net"
        assert ev.raw_metadata["project_id"] == 232604
        assert ev.raw_metadata["financial_id"] == "2026-RFP-0123"
        assert ev.raw_metadata["department"] == "Public Works"

    def test_build_event_falls_back_to_project_id_when_no_financial_id(self):
        s = self._scraper()
        ev = s._build_event(
            {"id": 999, "title": "Something", "summary": ""},
            listing_row={"id": 999},
        )
        assert ev is not None
        assert ev.source_event_id == "999"
        assert ev.source_url.endswith("/projects/999")

    def test_list_projects_uses_page_when_offset_is_clean_multiple(self, monkeypatch):
        from webscraping.v2.scrapers import opengov as og

        captured = {}

        class FakeResp:
            status_code = 200
            ok = True

            def raise_for_status(self):
                pass

            def json(self):
                return {"count": 100, "rows": [{"id": i} for i in range(12)]}

        def fake_post(url, json=None, timeout=None, headers=None):
            captured["url"] = url
            captured["body"] = json
            return FakeResp()

        monkeypatch.setattr(og.requests, "post", fake_post)

        s = self._scraper(batch_offset=24, batch_size=12)
        rows = s._list_projects()
        assert len(rows) == 12
        assert s.total_available == 100
        assert captured["body"] == {"status": "open", "page": 3, "limit": 12}
        assert captured["url"].endswith("/government/pasadena/project/public")

    def test_list_projects_slices_locally_when_offset_is_not_a_multiple(
        self, monkeypatch
    ):
        from webscraping.v2.scrapers import opengov as og

        captured = {}

        class FakeResp:
            status_code = 200
            ok = True

            def raise_for_status(self):
                pass

            def json(self):
                # 15 rows requested, return 15
                return {
                    "count": 50,
                    "rows": [{"id": i} for i in range(15)],
                }

        def fake_post(url, json=None, timeout=None, headers=None):
            captured["body"] = json
            return FakeResp()

        monkeypatch.setattr(og.requests, "post", fake_post)

        s = self._scraper(batch_offset=5, batch_size=10)
        rows = s._list_projects()
        # Should request page=1, limit=15, then slice [5:15]
        assert captured["body"]["page"] == 1
        assert captured["body"]["limit"] == 15
        assert [r["id"] for r in rows] == list(range(5, 15))


# ============================================================================
# OpenGov discovery probe tests (no network)
# ============================================================================

class TestOpenGovDiscoveryProbe:
    def _candidate(self, slug="long-beach"):
        from webscraping.v2.agents.discovery import Candidate
        return Candidate(
            platform="opengov",
            site_id=f"opengov_{slug.replace('-', '_')}",
            slug=slug,
            name=f"City of {slug.title()}",
            url=f"https://procurement.opengov.com/portal/{slug}",
        )

    def test_api_probe_verifies_when_count_positive(self, monkeypatch):
        from webscraping.v2.agents import discovery as disc

        class FakeResp:
            status_code = 200
            ok = True

            def json(self):
                return {"count": 7, "rows": [{}]}

        monkeypatch.setattr(disc.requests, "post", lambda *a, **kw: FakeResp())

        c = self._candidate()
        disc._probe_one_api_listing(c, disc.PLATFORM_PROFILES["opengov"])
        assert c.verified is True
        assert c.listing_count_observed == 7
        assert "count=7" in c.verification_notes

    def test_api_probe_rejects_when_count_zero(self, monkeypatch):
        from webscraping.v2.agents import discovery as disc

        class FakeResp:
            status_code = 200
            ok = True

            def json(self):
                return {"count": 0, "rows": []}

        monkeypatch.setattr(disc.requests, "post", lambda *a, **kw: FakeResp())

        c = self._candidate()
        disc._probe_one_api_listing(c, disc.PLATFORM_PROFILES["opengov"])
        assert c.verified is False
        assert "count=0" in c.verification_notes

    def test_api_probe_rejects_on_404(self, monkeypatch):
        from webscraping.v2.agents import discovery as disc

        class FakeResp:
            status_code = 404
            ok = False

            def json(self):
                return {}

        monkeypatch.setattr(disc.requests, "post", lambda *a, **kw: FakeResp())

        c = self._candidate(slug="not-a-real-slug")
        disc._probe_one_api_listing(c, disc.PLATFORM_PROFILES["opengov"])
        assert c.verified is False
        assert "404" in c.verification_notes


# ============================================================================
# Site investigation agent — pure-helper tests (no browser, no Anthropic API)
# ============================================================================

class TestInvestigationSpec:
    def test_valid_spec_roundtrips(self):
        from webscraping.v2.agents.site_investigation import (
            InvestigationSpec, ListingEndpoint, DetailEndpoint,
        )
        s = InvestigationSpec(
            portal_url="https://procurement.opengov.com/portal/pasadena",
            platform_class="opengov_api",
            confidence="high",
            listing=ListingEndpoint(
                method="POST",
                url_template="https://api.procurement.opengov.com/api/v1/government/{slug}/project/public",
                body_template='{"status":"open","page":1,"limit":50}',
                headers_required={"User-Agent": "Mozilla/5.0 ..."},
                response_format="json",
                rows_path="rows",
                row_id_field="id",
                row_title_field="title",
            ),
            detail=DetailEndpoint(
                method="GET",
                url_template="https://api.procurement.opengov.com/api/v1/project/{id}",
                response_format="json",
                summary_field="summary",
                attachment_array_path="attachments",
                attachment_url_field="url",
                attachment_filename_field="filename",
                contact_email_field="contactEmail",
            ),
            notes="API 403s default python-requests UA",
        )
        d = s.model_dump()
        assert d["platform_class"] == "opengov_api"
        assert d["listing"]["row_id_field"] == "id"
        assert d["detail"]["attachment_url_field"] == "url"

    def test_missing_required_listing_field_raises(self):
        from pydantic import ValidationError
        from webscraping.v2.agents.site_investigation import InvestigationSpec
        with pytest.raises(ValidationError):
            InvestigationSpec(
                portal_url="x",
                platform_class="opengov_api",
                confidence="high",
                # listing missing
            )


class TestToolSchemaIntegrity:
    def test_handler_names_match_schema_names(self):
        from webscraping.v2.agents.site_investigation import (
            TOOL_HANDLERS, TOOL_SCHEMAS,
        )
        schema_names = {s["name"] for s in TOOL_SCHEMAS}
        handler_names = set(TOOL_HANDLERS.keys())
        assert schema_names == handler_names, (
            f"diff: {schema_names ^ handler_names}"
        )

    def test_every_schema_is_well_formed(self):
        from webscraping.v2.agents.site_investigation import TOOL_SCHEMAS
        for s in TOOL_SCHEMAS:
            assert "name" in s
            assert "description" in s and len(s["description"]) > 20
            assert "input_schema" in s
            assert s["input_schema"]["type"] == "object"


class TestTerminalTools:
    def test_report_accepts_valid_spec(self):
        import asyncio
        from webscraping.v2.agents.site_investigation import (
            Toolbox, tool_report,
        )
        tb = Toolbox(page=None, capture=None)  # type: ignore[arg-type]
        spec_args = {
            "portal_url": "https://x",
            "platform_class": "opengov_api",
            "confidence": "high",
            "listing": {
                "method": "GET",
                "url_template": "https://x/api",
                "response_format": "json",
            },
        }
        result = asyncio.run(tool_report(tb, spec_args))
        assert "spec accepted" in result
        assert tb.spec_received is not None
        assert tb.spec_received.platform_class == "opengov_api"

    def test_report_rejects_invalid_spec(self):
        import asyncio
        from webscraping.v2.agents.site_investigation import (
            Toolbox, tool_report,
        )
        tb = Toolbox(page=None, capture=None)  # type: ignore[arg-type]
        result = asyncio.run(tool_report(tb, {"portal_url": "x"}))
        assert result.startswith("ERROR")
        assert tb.spec_received is None

    def test_give_up_records_reason(self):
        import asyncio
        from webscraping.v2.agents.site_investigation import (
            Toolbox, tool_give_up,
        )
        tb = Toolbox(page=None, capture=None)  # type: ignore[arg-type]
        asyncio.run(tool_give_up(tb, {"reason": "site requires login"}))
        assert tb.failure_reason == "site requires login"


class TestNetworkCaptureFilter:
    def test_filtered_drops_noise_hosts(self):
        from webscraping.v2.agents.site_investigation import (
            CapturedRequest, NetworkCapture,
        )

        # Bypass the constructor (it wires page event handlers); we only
        # exercise the filter logic.
        capture = NetworkCapture.__new__(NetworkCapture)
        capture.requests = [
            CapturedRequest(method="GET", url="https://api.procurement.opengov.com/api/v1/project/1", post_data=None, resource_type="xhr", timestamp=0),
            CapturedRequest(method="POST", url="https://api.segment.io/v1/p", post_data="x", resource_type="fetch", timestamp=0),
            CapturedRequest(method="POST", url="https://events.launchdarkly.com/events", post_data="x", resource_type="xhr", timestamp=0),
            CapturedRequest(method="GET", url="https://faro-collector-prod-us-central-0.grafana.net/collect", post_data=None, resource_type="fetch", timestamp=0),
        ]
        out = capture.filtered()
        assert len(out) == 1
        assert "opengov.com" in out[0].url

    def test_filtered_with_host_filter(self):
        from webscraping.v2.agents.site_investigation import (
            CapturedRequest, NetworkCapture,
        )
        capture = NetworkCapture.__new__(NetworkCapture)
        capture.requests = [
            CapturedRequest(method="GET", url="https://api.procurement.opengov.com/api/v1/x", post_data=None, resource_type="xhr", timestamp=0),
            CapturedRequest(method="GET", url="https://www.rampla.org/s/sfsites/aura", post_data=None, resource_type="xhr", timestamp=0),
        ]
        og = capture.filtered("opengov")
        assert len(og) == 1
        assert "opengov" in og[0].url


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
