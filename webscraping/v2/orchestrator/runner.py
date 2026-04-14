"""
Orchestrator that ties scrapers and the processing pipeline together.

Usage:
    python -m webscraping.v2.orchestrator.runner                    # run all enabled sites
    python -m webscraping.v2.orchestrator.runner --site caleprocure # run one site
    python -m webscraping.v2.orchestrator.runner --site caleprocure --skip-enrich  # scrape only
    python -m webscraping.v2.orchestrator.runner --list             # list registered sites
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from datetime import datetime

import boto3

from webscraping.v2.config import (
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_REGION,
    S3_BUCKET,
    S3_V2_PREFIX,
    S3_LEGACY_PREFIX,
)
from webscraping.v2.models import (
    RawScrapedEvent,
    EnrichedEvent,
    EventStatus,
    SiteConfig,
    SourceManifest,
    ScraperType,
)
from webscraping.v2.scrapers.base import BaseScraper, make_event_id
from webscraping.v2.pipeline.normalize import normalize_event
from webscraping.v2.pipeline.enrich import enrich_event

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Site registry (in-code for now, migrate to DynamoDB later)
# ---------------------------------------------------------------------------

def _build_site_registry() -> dict[str, SiteConfig]:
    """Build the full site registry from all scraper modules."""
    from webscraping.v2.scrapers.bidsync import get_bidsync_site_configs
    from webscraping.v2.scrapers.planetbids import get_planetbids_site_configs

    registry: dict[str, SiteConfig] = {
        "caleprocure": SiteConfig(
            site_id="caleprocure",
            name="Cal eProcure",
            url="https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx",
            scraper_type=ScraperType.STRUCTURED,
            schedule_cron="0 */4 * * *",
            min_request_interval_ms=2000,
            priority=1,
        ),
    }

    # Add BidSync agencies (~15 agencies)
    registry.update(get_bidsync_site_configs())

    # Add PlanetBids agencies (~44 agencies)
    registry.update(get_planetbids_site_configs())

    # Agentic sites (custom portals that aren't on PlanetBids/BidSync)
    # San Diego + Sacramento are now on PlanetBids; Oakland uses iSupplier (not scrapable)
    agentic_sites = [
        ("la_city", "City of Los Angeles", "https://www.labavn.org/"),
        ("sf_city", "City of San Francisco", "https://sfgov.org/oca/contracting-opportunities"),
    ]
    for site_id, name, url in agentic_sites:
        registry[site_id] = SiteConfig(
            site_id=site_id,
            name=name,
            url=url,
            scraper_type=ScraperType.AGENTIC,
            min_request_interval_ms=5000,
            priority=2,
        )

    return registry


SITE_REGISTRY = _build_site_registry()


def get_scraper(site_config: SiteConfig) -> BaseScraper:
    """Factory: instantiate the right scraper for a site config."""
    if site_config.site_id == "caleprocure":
        from webscraping.v2.scrapers.caleprocure import CalEprocureScraper
        return CalEprocureScraper(site_config)

    if site_config.site_id.startswith("bidsync"):
        from webscraping.v2.scrapers.bidsync import BidSyncScraper
        return BidSyncScraper(site_config)

    if site_config.scraper_type in (ScraperType.STRUCTURED, ScraperType.API):
        from webscraping.v2.scrapers.planetbids import PlanetBidsScraper
        return PlanetBidsScraper(site_config)

    if site_config.scraper_type == ScraperType.AGENTIC:
        from webscraping.v2.scrapers.agentic import AgenticScraper
        return AgenticScraper(site_config)

    raise ValueError(f"No scraper registered for site: {site_config.site_id}")


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------

def get_s3():
    return boto3.client(
        "s3",
        region_name=AWS_REGION,
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
    )


def load_existing_manifest(s3, source_id: str) -> dict[str, EnrichedEvent]:
    """Load existing events from S3 manifest, keyed by event ID."""
    key = f"{S3_V2_PREFIX}manifests/{source_id}/latest.json"
    try:
        resp = s3.get_object(Bucket=S3_BUCKET, Key=key)
        data = json.loads(resp["Body"].read())
        return {
            e["id"]: EnrichedEvent(**e)
            for e in data.get("events", [])
        }
    except Exception:
        return {}


def merge_events(
    existing: dict[str, EnrichedEvent],
    fresh: list[EnrichedEvent],
) -> list[EnrichedEvent]:
    """
    Merge freshly scraped events with existing persisted events.

    - New events: added with status=open
    - Still-present events: updated with latest data, last_seen_at refreshed
    - Missing events (in existing but not in fresh): marked as closed
    """
    now = datetime.now().isoformat()
    fresh_by_id = {e.id: e for e in fresh}
    merged: dict[str, EnrichedEvent] = {}

    # Update or close existing events
    for eid, existing_event in existing.items():
        if eid in fresh_by_id:
            # Still on the site — update with fresh data, keep first_seen_at
            updated = fresh_by_id[eid]
            updated.first_seen_at = existing_event.first_seen_at
            updated.last_seen_at = now
            updated.status = EventStatus.OPEN
            updated.closed_at = None
            merged[eid] = updated
        else:
            # No longer on the site — mark as closed
            existing_event.status = EventStatus.CLOSED
            if not existing_event.closed_at:
                existing_event.closed_at = now
            merged[eid] = existing_event

    # Add brand new events
    for eid, fresh_event in fresh_by_id.items():
        if eid not in merged:
            fresh_event.first_seen_at = now
            fresh_event.last_seen_at = now
            fresh_event.status = EventStatus.OPEN
            merged[eid] = fresh_event

    return list(merged.values())


def upload_manifest(s3, source_id: str, source_name: str, events: list[EnrichedEvent]):
    """Upload source manifest to v2 path."""
    manifest = SourceManifest(
        source_id=source_id,
        source_name=source_name,
        total_events=len(events),
        events=events,
    )
    key = f"{S3_V2_PREFIX}manifests/{source_id}/latest.json"
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=manifest.model_dump_json(indent=2),
        ContentType="application/json",
    )
    open_count = sum(1 for e in events if e.status == EventStatus.OPEN)
    closed_count = len(events) - open_count
    logger.info(f"Uploaded manifest: {key} ({open_count} open, {closed_count} closed, {len(events)} total)")


def upload_legacy_format(s3, events: list[EnrichedEvent], enrichments: dict):
    """Write legacy all_events.json + attachment_extractions.json for backward compat."""
    # Convert enriched events back to legacy format
    legacy_events = []
    for e in events:
        legacy_events.append({
            "event_id": e.source_event_id,
            "event_url": e.source_url,
            "title": e.title,
            "description": e.description,
            "department": e.agency,
            "format": e.procurement_type,
            "start_date": e.posted_date or "",
            "end_date": e.deadline,
            "contact_name": e.contact.name or "",
            "contact_email": e.contact.email or "",
            "contact_phone": e.contact.phone or "",
        })

    s3.put_object(
        Bucket=S3_BUCKET,
        Key=f"{S3_LEGACY_PREFIX}all_events.json",
        Body=json.dumps({
            "scrape_date": datetime.now().isoformat(),
            "total_events": len(legacy_events),
            "events": legacy_events,
        }, indent=2, ensure_ascii=False),
        ContentType="application/json",
    )

    if enrichments:
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=f"{S3_LEGACY_PREFIX}attachment_extractions.json",
            Body=json.dumps(enrichments, indent=2, ensure_ascii=False),
            ContentType="application/json",
        )

    logger.info(f"Uploaded legacy format: {len(legacy_events)} events")


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

async def run_site(site_id: str, skip_enrich: bool = False, skip_upload: bool = False):
    """Run the full scrape + enrich + upload pipeline for a single site."""
    if site_id not in SITE_REGISTRY:
        raise ValueError(f"Unknown site: {site_id}. Available: {list(SITE_REGISTRY.keys())}")

    config = SITE_REGISTRY[site_id]
    scraper = get_scraper(config)

    # 1. Scrape
    logger.info(f"=== Scraping {config.name} ===")
    raw_events = await scraper.run()
    logger.info(f"Scraped {len(raw_events)} raw events")

    if not raw_events:
        logger.warning("No events scraped, exiting")
        return []

    # 2. Enrich (optional)
    enrichments: dict = {}
    if not skip_enrich:
        logger.info("=== Enriching events (PDF extraction) ===")
        for event in raw_events:
            if event.attachment_urls:
                try:
                    extraction = enrich_event(event)
                    if extraction:
                        enrichments[event.source_event_id] = extraction.model_dump()
                        logger.info(f"  Enriched: {event.title[:50]}")
                except Exception as e:
                    logger.warning(f"  Enrichment failed for {event.source_event_id}: {e}")

    # 3. Normalize
    logger.info("=== Normalizing events ===")
    from webscraping.v2.models import AttachmentExtraction

    enriched_events = []
    for event in raw_events:
        extraction = None
        if event.source_event_id in enrichments:
            extraction = AttachmentExtraction(**enrichments[event.source_event_id])
        enriched = normalize_event(event, extraction)
        enriched_events.append(enriched)

    # 4. Merge with existing events + Upload
    if not skip_upload:
        logger.info("=== Merging with existing events and uploading to S3 ===")
        s3 = get_s3()

        # Load existing manifest and merge
        existing = load_existing_manifest(s3, config.site_id)
        if existing:
            logger.info(f"Loaded {len(existing)} existing events from manifest")
        merged_events = merge_events(existing, enriched_events)

        # v2 manifest
        upload_manifest(s3, config.site_id, config.name, merged_events)

        # Legacy format (for backward compat — only includes open events)
        if site_id == "caleprocure":
            open_events = [e for e in merged_events if e.status == EventStatus.OPEN]
            upload_legacy_format(s3, open_events, enrichments)

        enriched_events = merged_events

    logger.info(f"=== Done: {len(enriched_events)} events processed ===")
    return enriched_events


async def run_site_batch(
    site_id: str,
    batch_offset: int = 0,
    batch_size: int = 40,
    skip_enrich: bool = True,
) -> dict:
    """
    Run a single batch of scraping for a site. Used by the Lambda handler
    for chained invocations.

    Returns: {"events_scraped": N, "total_events": M}
    """
    if site_id not in SITE_REGISTRY:
        raise ValueError(f"Unknown site: {site_id}")

    config = SITE_REGISTRY[site_id]

    # Create scraper with batch parameters
    if site_id == "caleprocure":
        from webscraping.v2.scrapers.caleprocure import CalEprocureScraper
        scraper = CalEprocureScraper(config, batch_offset=batch_offset, batch_size=batch_size)
    else:
        scraper = get_scraper(config)

    # Scrape
    logger.info(f"=== Scraping {config.name} (batch offset={batch_offset}, size={batch_size}) ===")
    raw_events = await scraper.run()
    logger.info(f"Scraped {len(raw_events)} raw events")

    total_events = getattr(scraper, "total_available", len(raw_events))

    if not raw_events:
        return {"events_scraped": 0, "total_events": total_events}

    # Enrich
    enrichments: dict = {}
    if not skip_enrich:
        for event in raw_events:
            if event.attachment_urls:
                try:
                    extraction = enrich_event(event)
                    if extraction:
                        enrichments[event.source_event_id] = extraction.model_dump()
                except Exception as e:
                    logger.warning(f"Enrichment failed: {e}")

    # Normalize
    from webscraping.v2.models import AttachmentExtraction as AE
    enriched_events = []
    for event in raw_events:
        extraction = AE(**enrichments[event.source_event_id]) if event.source_event_id in enrichments else None
        enriched_events.append(normalize_event(event, extraction))

    # Merge with existing and upload
    s3 = get_s3()
    existing = load_existing_manifest(s3, config.site_id)
    if existing:
        logger.info(f"Loaded {len(existing)} existing events")

    # For batched scraping, we ADD to existing without marking anything as closed
    # (since we're only scraping a subset). Closing happens only on full scrapes.
    now = datetime.now().isoformat()
    for event in enriched_events:
        eid = event.id
        if eid in existing:
            event.first_seen_at = existing[eid].first_seen_at
        event.last_seen_at = now
        event.status = EventStatus.OPEN
        existing[eid] = event

    all_events = list(existing.values())
    upload_manifest(s3, config.site_id, config.name, all_events)

    # Legacy format
    if site_id == "caleprocure":
        open_events = [e for e in all_events if e.status == EventStatus.OPEN]
        upload_legacy_format(s3, open_events, enrichments)

    return {"events_scraped": len(raw_events), "total_events": total_events}


async def run_all(skip_enrich: bool = False, skip_upload: bool = False):
    """Run the pipeline for all enabled sites."""
    results = {}
    for site_id, config in SITE_REGISTRY.items():
        if not config.enabled:
            logger.info(f"Skipping disabled site: {site_id}")
            continue
        try:
            events = await run_site(site_id, skip_enrich=skip_enrich, skip_upload=skip_upload)
            results[site_id] = len(events)
        except Exception as e:
            logger.error(f"Failed to process {site_id}: {e}")
            results[site_id] = -1

    logger.info(f"\n=== Summary ===")
    for site_id, count in results.items():
        status = f"{count} events" if count >= 0 else "FAILED"
        logger.info(f"  {site_id}: {status}")

    return results


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Civitas RFP Scraping System v2")
    parser.add_argument("--site", help="Run a specific site (default: all enabled)")
    parser.add_argument("--list", action="store_true", help="List registered sites")
    parser.add_argument("--skip-enrich", action="store_true", help="Skip PDF enrichment")
    parser.add_argument("--skip-upload", action="store_true", help="Skip S3 upload")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    if args.list:
        print("\nRegistered sites:")
        for site_id, config in SITE_REGISTRY.items():
            status = "enabled" if config.enabled else "disabled"
            print(f"  {site_id}: {config.name} [{config.scraper_type.value}] ({status})")
        return

    if args.site:
        asyncio.run(run_site(args.site, skip_enrich=args.skip_enrich, skip_upload=args.skip_upload))
    else:
        asyncio.run(run_all(skip_enrich=args.skip_enrich, skip_upload=args.skip_upload))


if __name__ == "__main__":
    main()
