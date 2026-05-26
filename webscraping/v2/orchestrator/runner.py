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
import os
import random
import time
from datetime import datetime

import requests
from botocore.exceptions import ClientError

from webscraping.v2.config import (
    S3_BUCKET,
    S3_V2_PREFIX,
    S3_LEGACY_PREFIX,
    get_s3_client,
)
from webscraping.v2.models import (
    AttachmentExtraction,
    RawScrapedEvent,
    EnrichedEvent,
    EventStatus,
    KeyDates,
    SiteConfig,
    SourceManifest,
    ScraperType,
)
from webscraping.v2.scrapers.base import BaseScraper, make_event_id
from webscraping.v2.pipeline.normalize import normalize_event
from webscraping.v2.pipeline.enrich import enrich_event
from webscraping.v2.pipeline.health import record_run

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Site registry (in-code for now, migrate to DynamoDB later)
# ---------------------------------------------------------------------------

def _build_site_registry() -> dict[str, SiteConfig]:
    """Build the full site registry from all scraper modules."""
    from webscraping.v2.scrapers.bidsync import get_bidsync_site_configs
    from webscraping.v2.scrapers.opengov import get_opengov_site_configs
    from webscraping.v2.scrapers.planetbids import get_planetbids_site_configs
    from webscraping.v2.scrapers.spec_driven import get_spec_driven_site_configs

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

    # Add PlanetBids agencies (~43 agencies; Pasadena moved off PlanetBids)
    registry.update(get_planetbids_site_configs())

    # Add OpenGov agencies (Pasadena seed; more added by discovery agent)
    registry.update(get_opengov_site_configs())

    # Add spec-driven sites — onboarded by the investigation agent and
    # stored as JSON in s3://.../scrapes/v2/spec_sites/{site_id}.json.
    # No code deploy needed to add a new platform here.
    registry.update(get_spec_driven_site_configs())

    # Agentic sites (custom portals that aren't on PlanetBids/BidSync).
    # San Diego + Sacramento are now on PlanetBids; Oakland uses iSupplier (not scrapable).
    # LA City (labavn.org) DNS-fails on Lambda; SF City URL was a 404 — both
    # disabled until the agentic onboarding pipeline (which can re-discover
    # the listing page) takes over. Keeping the entries so re-enabling is
    # one config flip away.
    agentic_sites = [
        ("la_city", "City of Los Angeles", "https://www.labavn.org/", False),
        (
            "sf_city",
            "City of San Francisco",
            "https://sf.gov/topics/contracting-opportunities",
            False,
        ),
    ]
    for site_id, name, url, enabled in agentic_sites:
        registry[site_id] = SiteConfig(
            site_id=site_id,
            name=name,
            url=url,
            scraper_type=ScraperType.AGENTIC,
            min_request_interval_ms=5000,
            priority=2,
            enabled=enabled,
        )

    return registry


SITE_REGISTRY = _build_site_registry()


def get_scraper(site_config: SiteConfig, include_awarded: bool = False) -> BaseScraper:
    """Factory: instantiate the right scraper for a site config."""
    if site_config.site_id == "caleprocure":
        from webscraping.v2.scrapers.caleprocure import CalEprocureScraper
        return CalEprocureScraper(site_config)

    if site_config.site_id.startswith("bidsync"):
        from webscraping.v2.scrapers.bidsync import BidSyncScraper
        return BidSyncScraper(site_config)

    if site_config.site_id.startswith("opengov_"):
        from webscraping.v2.scrapers.opengov import OpenGovScraper
        return OpenGovScraper(site_config)

    if site_config.scraper_type == ScraperType.SPEC_DRIVEN:
        from webscraping.v2.scrapers.spec_driven import SpecDrivenScraper
        return SpecDrivenScraper(site_config)

    if site_config.scraper_type in (ScraperType.STRUCTURED, ScraperType.API):
        from webscraping.v2.scrapers.planetbids import PlanetBidsScraper
        return PlanetBidsScraper(site_config, include_awarded=include_awarded)

    if site_config.scraper_type == ScraperType.AGENTIC:
        from webscraping.v2.scrapers.agentic import AgenticScraper
        return AgenticScraper(site_config)

    raise ValueError(f"No scraper registered for site: {site_config.site_id}")


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------

def get_s3():
    return get_s3_client()


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
            # Preserve historical market intel if this run didn't capture it.
            # bid_results / award are only visible on Awarded-status passes;
            # a subsequent Bidding-only re-scrape would otherwise clobber them.
            if not updated.bid_results and existing_event.bid_results:
                updated.bid_results = existing_event.bid_results
            if updated.award is None and existing_event.award is not None:
                updated.award = existing_event.award
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
    """Upload source manifest to v2 path. Unconditional write — used by tests
    and for first-time manifest creation. Concurrent scrape runs should use
    upload_manifest_cas() instead to avoid clobbering each other's writes."""
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


def upload_manifest_cas(
    s3,
    source_id: str,
    source_name: str,
    new_events: list[EnrichedEvent],
    close_missing: bool = False,
    max_retries: int = 6,
) -> None:
    """Apply `new_events` into the latest manifest atomically via S3 ETag CAS.

    The chained Lambda invocations on Cal eProcure (and the `mode=all` fan-out
    on PlanetBids/agentic sites) write the same manifest from multiple
    in-flight Lambdas. A blind put_object lets the last writer clobber
    in-between batches' work — the symptom we saw is PDFs mirrored into
    s3://civitas-ai/scrapes/v2/attachments/... that never made it into the
    manifest because another batch's write landed on top.

    This helper closes that race with a get-modify-put loop:

      1. GET manifest, capture ETag.
      2. Merge `new_events` into the loaded dict (preserve first_seen_at,
         carry forward bid_results / award when this run didn't capture them).
      3. If `close_missing`, mark anything in `existing` but not in
         `new_events` as closed — only used by full-sweep `merge_events`
         callers, NOT by the per-batch path.
      4. PUT with `If-Match: <etag>` (or `If-None-Match: *` if creating new).
      5. On `PreconditionFailed`, exponential-backoff retry up to max_retries.

    Raises RuntimeError if retries exhaust — caller can decide whether to
    re-queue this batch or surface the failure.
    """
    key = f"{S3_V2_PREFIX}manifests/{source_id}/latest.json"
    now = datetime.now().isoformat()

    for attempt in range(max_retries):
        # 1. GET latest with ETag (or note that the manifest doesn't exist yet).
        existing_etag: str | None = None
        existing: dict[str, EnrichedEvent] = {}
        try:
            resp = s3.get_object(Bucket=S3_BUCKET, Key=key)
            existing_etag = resp.get("ETag")
            try:
                data = json.loads(resp["Body"].read())
                existing = {
                    e["id"]: EnrichedEvent(**e)
                    for e in data.get("events", [])
                }
            except Exception as parse_err:
                logger.warning(
                    f"upload_manifest_cas: existing manifest parse failed "
                    f"({parse_err}); treating as empty"
                )
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code != "NoSuchKey":
                raise

        # 2. Merge fresh events on top.
        merged: dict[str, EnrichedEvent] = dict(existing)
        fresh_ids: set[str] = set()
        for event in new_events:
            fresh_ids.add(event.id)
            prior = existing.get(event.id)
            if prior is not None:
                event.first_seen_at = prior.first_seen_at
                # Carry forward market intel that wasn't captured this run
                # (Awarded-only data on a Bidding-only re-scrape).
                if not event.bid_results and prior.bid_results:
                    event.bid_results = prior.bid_results
                if event.award is None and prior.award is not None:
                    event.award = prior.award
            event.last_seen_at = now
            event.status = EventStatus.OPEN
            event.closed_at = None
            merged[event.id] = event

        # 3. Optional sweep-close of events absent from this run.
        if close_missing:
            for eid, evt in list(merged.items()):
                if eid not in fresh_ids:
                    evt.status = EventStatus.CLOSED
                    if not evt.closed_at:
                        evt.closed_at = now

        all_events = list(merged.values())

        # 4. PUT with conditional header.
        manifest = SourceManifest(
            source_id=source_id,
            source_name=source_name,
            total_events=len(all_events),
            events=all_events,
        )
        body = manifest.model_dump_json(indent=2)
        put_kwargs: dict = {
            "Bucket": S3_BUCKET,
            "Key": key,
            "Body": body,
            "ContentType": "application/json",
        }
        if existing_etag is not None:
            put_kwargs["IfMatch"] = existing_etag
        else:
            # No existing manifest yet — refuse to overwrite if someone else
            # creates one between our GET and PUT.
            put_kwargs["IfNoneMatch"] = "*"

        try:
            s3.put_object(**put_kwargs)
            open_count = sum(1 for e in all_events if e.status == EventStatus.OPEN)
            closed_count = len(all_events) - open_count
            logger.info(
                f"Uploaded manifest CAS (attempt={attempt + 1}): {key} "
                f"({open_count} open, {closed_count} closed, "
                f"{len(all_events)} total, new={len(new_events)})"
            )
            return
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            # S3 returns PreconditionFailed for If-Match mismatch and
            # ConditionalRequestConflict / PreconditionFailed for If-None-Match.
            if code in ("PreconditionFailed", "ConditionalRequestConflict"):
                # Backoff with jitter so retries don't synchronize.
                wait = min(2 ** attempt, 8) + random.uniform(0, 0.5)
                logger.warning(
                    f"upload_manifest_cas: ETag conflict on {source_id} "
                    f"(attempt {attempt + 1}/{max_retries}), retrying in {wait:.1f}s"
                )
                time.sleep(wait)
                continue
            raise

    raise RuntimeError(
        f"upload_manifest_cas: exhausted {max_retries} retries on {source_id} "
        "due to concurrent writes"
    )


def notify_rfp_cache_sync(source_id: str) -> None:
    """Fire-and-forget: tell the Next.js app to pull this source's manifest
    into Postgres and refresh Voyage embeddings for any new rows.

    The scrape is the source of truth; this call just keeps the relational
    cache and embedding index in sync. Failures are logged and swallowed —
    a transient sync miss self-heals on the next batch.

    Requires CIVITAS_APP_ORIGIN + CIVITAS_CRON_SECRET in the Lambda env.
    Both unset = silently skip (e.g. local CLI runs).
    """
    origin = os.environ.get("CIVITAS_APP_ORIGIN")
    secret = os.environ.get("CIVITAS_CRON_SECRET")
    if not origin or not secret:
        logger.debug("rfp_cache sync skipped: CIVITAS_APP_ORIGIN/SECRET not set")
        return
    url = origin.rstrip("/") + "/api/cron/sync-rfp-cache"
    try:
        resp = requests.post(
            url,
            json={"source_id": source_id},
            headers={"Authorization": f"Bearer {secret}"},
            timeout=10,
        )
        if resp.status_code >= 300:
            logger.warning(
                "rfp_cache sync returned %s for %s: %s",
                resp.status_code, source_id, resp.text[:200],
            )
        else:
            logger.info("rfp_cache sync queued for %s", source_id)
    except Exception as e:
        logger.warning("rfp_cache sync request failed for %s: %s", source_id, e)


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
# Re-enrichment short-circuit
# ---------------------------------------------------------------------------
#
# Without these helpers every scrape blindly re-sent every event's PDFs to
# Haiku, even though most events sit on portals unchanged for weeks. The
# guard below carries the prior AttachmentExtraction forward whenever the
# attachment URL set is identical AND the prior extraction looks healthy
# (real summary + at least one structured field). Failed/"Unknown" prior
# extractions still get retried, and any change to attachment_urls
# (addenda, replaced PDFs) forces a fresh enrichment.

_KEY_DATE_FIELDS = (
    "qa_deadline", "qa_response_date", "prebid_meeting_at",
    "site_visit_at", "award_date", "contract_start", "contract_end",
)


def _is_enrichment_healthy(prior: EnrichedEvent) -> bool:
    rollup = prior.attachment_rollup if isinstance(prior.attachment_rollup, dict) else {}
    summary = (rollup.get("summary") or "").strip() if rollup else ""
    if not summary or summary == "Unknown":
        return False
    if prior.naics_codes or prior.deliverables or prior.licenses_required:
        return True
    kd = prior.key_dates
    if kd is not None:
        for field in _KEY_DATE_FIELDS:
            if getattr(kd, field, None):
                return True
    return False


def _attachment_urls_unchanged(prior: EnrichedEvent, raw: RawScrapedEvent) -> bool:
    return set(prior.attachment_urls) == set(raw.attachment_urls)


def _extraction_from_prior(prior: EnrichedEvent) -> AttachmentExtraction:
    rollup = prior.attachment_rollup if isinstance(prior.attachment_rollup, dict) else {}
    return AttachmentExtraction(
        naics_codes=list(prior.naics_codes),
        certifications_required=list(prior.certifications),
        licenses_required=list(prior.licenses_required),
        incumbent_vendor=prior.incumbent_vendor,
        incumbent_contract_end=prior.incumbent_contract_end,
        clearances_required=list(prior.clearances_required),
        set_aside_types=list(prior.set_aside_types),
        capabilities_required=[],
        contract_value_estimate=(
            prior.estimated_value if prior.estimated_value and prior.estimated_value != "TBD" else None
        ),
        contract_duration=prior.contract_duration,
        location_details=(
            [prior.location] if prior.location and prior.location != "California" else []
        ),
        onsite_required=None,
        key_requirements_summary=(rollup.get("summary") if rollup else None) or "Unknown",
        deliverables=list(prior.deliverables),
        evaluation_criteria=list(prior.evaluation_criteria),
        key_dates=prior.key_dates if prior.key_dates is not None else KeyDates(),
        attachment_text_rollup=(rollup.get("text") if rollup else "") or "",
        pdfs_processed=(rollup.get("pdfsProcessed") if rollup else None) or [],
        total_pdfs_available=len(prior.attachment_urls),
    )


def _enrich_or_carry_forward(
    raw_events: list[RawScrapedEvent],
    source_id: str,
    s3,
) -> dict[str, dict]:
    """Run enrichment for events that need it; carry prior extractions forward
    when the attachment set is unchanged and prior data looks real.

    Returns: dict keyed by source_event_id mapping to AttachmentExtraction.model_dump().
    """
    existing = load_existing_manifest(s3, source_id)
    enrichments: dict[str, dict] = {}
    skipped = 0
    enriched = 0
    failed = 0
    for event in raw_events:
        if not event.attachment_urls:
            continue
        eid = make_event_id(event.source_id, event.source_event_id)
        prior = existing.get(eid)
        if (
            prior is not None
            and _is_enrichment_healthy(prior)
            and _attachment_urls_unchanged(prior, event)
        ):
            enrichments[event.source_event_id] = _extraction_from_prior(prior).model_dump()
            skipped += 1
            continue
        try:
            extraction = enrich_event(event)
            if extraction:
                enrichments[event.source_event_id] = extraction.model_dump()
                enriched += 1
                logger.info(f"  Enriched: {event.title[:50]}")
        except Exception as e:
            failed += 1
            logger.warning(f"  Enrichment failed for {event.source_event_id}: {e}")
    logger.info(
        f"Enrichment: {enriched} new/changed, {skipped} carried forward, {failed} failed"
    )
    return enrichments


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

async def run_site(
    site_id: str,
    skip_enrich: bool = False,
    skip_upload: bool = False,
    include_awarded: bool = False,
):
    """Run the full scrape + enrich + upload pipeline for a single site."""
    if site_id not in SITE_REGISTRY:
        raise ValueError(f"Unknown site: {site_id}. Available: {list(SITE_REGISTRY.keys())}")

    config = SITE_REGISTRY[site_id]
    scraper = get_scraper(config, include_awarded=include_awarded)

    # 1. Scrape
    logger.info(f"=== Scraping {config.name} ===")
    try:
        raw_events = await scraper.run()
    except Exception as e:
        record_run(
            source_id=site_id,
            source_name=config.name,
            events_scraped=0,
            error=f"scrape failed: {e}",
        )
        raise
    logger.info(f"Scraped {len(raw_events)} raw events")

    if not raw_events:
        logger.warning("No events scraped, exiting")
        record_run(
            source_id=site_id,
            source_name=config.name,
            events_scraped=0,
            error="no events scraped",
        )
        return []

    # 2. Enrich (optional) — skips events whose prior extraction is healthy
    #    and whose attachment_urls haven't changed since the last scrape.
    enrichments: dict = {}
    if not skip_enrich:
        logger.info("=== Enriching events (PDF extraction) ===")
        enrichments = _enrich_or_carry_forward(raw_events, config.site_id, get_s3())

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

    # 4. Merge with existing events + Upload (atomic CAS to survive
    #    chained-Lambda concurrent writes on the same manifest)
    if not skip_upload:
        logger.info("=== Atomically applying scrape to S3 manifest (CAS) ===")
        s3 = get_s3()

        # close_missing=True for a full scrape: events absent from this run
        # are marked closed. The batched path uses close_missing=False.
        upload_manifest_cas(
            s3, config.site_id, config.name, enriched_events,
            close_missing=True,
        )

        # Re-load post-CAS to get the truthy merged view for downstream
        # operations (legacy format dump, return value).
        merged_dict = load_existing_manifest(s3, config.site_id)
        merged_events = list(merged_dict.values())

        # Legacy format (for backward compat — only includes open events)
        if site_id == "caleprocure":
            open_events = [e for e in merged_events if e.status == EventStatus.OPEN]
            upload_legacy_format(s3, open_events, enrichments)

        # Push this source into Postgres + refresh Voyage embeddings.
        notify_rfp_cache_sync(config.site_id)

        enriched_events = merged_events

    record_run(
        source_id=site_id,
        source_name=config.name,
        events_scraped=len(raw_events),
        pdfs_observed=sum(len(e.attachment_urls) for e in raw_events),
    )

    logger.info(f"=== Done: {len(enriched_events)} events processed ===")
    return enriched_events


async def run_site_batch(
    site_id: str,
    batch_offset: int = 0,
    batch_size: int = 40,
    skip_enrich: bool = False,
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
    elif site_id.startswith("planetbids_"):
        from webscraping.v2.scrapers.planetbids import PlanetBidsScraper
        scraper = PlanetBidsScraper(
            config, batch_offset=batch_offset, batch_size=batch_size
        )
    elif site_id.startswith("opengov_"):
        from webscraping.v2.scrapers.opengov import OpenGovScraper
        scraper = OpenGovScraper(
            config, batch_offset=batch_offset, batch_size=batch_size
        )
    elif config.scraper_type == ScraperType.SPEC_DRIVEN:
        from webscraping.v2.scrapers.spec_driven import SpecDrivenScraper
        scraper = SpecDrivenScraper(
            config, batch_offset=batch_offset, batch_size=batch_size
        )
    else:
        scraper = get_scraper(config)

    # Scrape
    logger.info(f"=== Scraping {config.name} (batch offset={batch_offset}, size={batch_size}) ===")
    try:
        raw_events = await scraper.run()
    except Exception as e:
        record_run(
            source_id=site_id,
            source_name=config.name,
            events_scraped=0,
            error=f"batch scrape failed (offset={batch_offset}): {e}",
        )
        raise
    logger.info(f"Scraped {len(raw_events)} raw events")

    total_events = getattr(scraper, "total_available", len(raw_events))

    if not raw_events:
        if batch_offset == 0:
            record_run(
                source_id=site_id,
                source_name=config.name,
                events_scraped=0,
                error="batch returned 0 events",
            )
        return {"events_scraped": 0, "total_events": total_events}

    record_run(
        source_id=site_id,
        source_name=config.name,
        events_scraped=len(raw_events),
        pdfs_observed=sum(len(e.attachment_urls) for e in raw_events),
    )

    # Enrich — skips events whose prior extraction is healthy and whose
    # attachment_urls haven't changed since the last scrape.
    enrichments: dict = {}
    if not skip_enrich:
        enrichments = _enrich_or_carry_forward(raw_events, config.site_id, get_s3())

    # Normalize
    from webscraping.v2.models import AttachmentExtraction as AE
    enriched_events = []
    for event in raw_events:
        extraction = AE(**enrichments[event.source_event_id]) if event.source_event_id in enrichments else None
        enriched_events.append(normalize_event(event, extraction))

    # Apply this batch to the manifest atomically. For chained Cal eProcure
    # batches running concurrently, a blind upload_manifest let later writers
    # clobber earlier writers' events (the orphaned-mirror bug). CAS GET-PUT
    # with ETag conflict retry serializes the writes.
    s3 = get_s3()
    upload_manifest_cas(
        s3, config.site_id, config.name, enriched_events,
        close_missing=False,
    )

    # Re-load post-CAS for the legacy format dump (Cal eProcure only).
    merged_dict = load_existing_manifest(s3, config.site_id)
    all_events = list(merged_dict.values())

    # Legacy format
    if site_id == "caleprocure":
        open_events = [e for e in all_events if e.status == EventStatus.OPEN]
        upload_legacy_format(s3, open_events, enrichments)

    # Push this source into Postgres + refresh Voyage embeddings.
    notify_rfp_cache_sync(config.site_id)

    return {"events_scraped": len(raw_events), "total_events": total_events}


async def run_all(
    skip_enrich: bool = False,
    skip_upload: bool = False,
    include_awarded: bool = False,
):
    """Run the pipeline for all enabled sites."""
    results = {}
    for site_id, config in SITE_REGISTRY.items():
        if not config.enabled:
            logger.info(f"Skipping disabled site: {site_id}")
            continue
        try:
            events = await run_site(
                site_id,
                skip_enrich=skip_enrich,
                skip_upload=skip_upload,
                include_awarded=include_awarded,
            )
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
    parser.add_argument(
        "--include-awarded",
        action="store_true",
        help="Also scrape Awarded-status events for historical contract data (PlanetBids only)",
    )
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
        asyncio.run(
            run_site(
                args.site,
                skip_enrich=args.skip_enrich,
                skip_upload=args.skip_upload,
                include_awarded=args.include_awarded,
            )
        )
    else:
        asyncio.run(
            run_all(
                skip_enrich=args.skip_enrich,
                skip_upload=args.skip_upload,
                include_awarded=args.include_awarded,
            )
        )


if __name__ == "__main__":
    main()
