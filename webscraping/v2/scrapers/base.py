"""
Base scraper interface for all scraper tiers.

Every scraper (API, structured, agentic) must extend BaseScraper and implement
the `scrape()` method, which yields RawScrapedEvent objects.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from abc import ABC, abstractmethod
from datetime import datetime
from typing import AsyncIterator

import boto3

from webscraping.v2.config import (
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_REGION,
    S3_BUCKET,
    S3_V2_PREFIX,
    DEFAULT_REQUEST_INTERVAL_MS,
)
from webscraping.v2.models import RawScrapedEvent, SiteConfig, SourceManifest, EnrichedEvent
from webscraping.v2.utils import event_hash, make_event_id

logger = logging.getLogger(__name__)


class BaseScraper(ABC):
    """Abstract base class for all scrapers."""

    def __init__(self, site_config: SiteConfig):
        self.site_config = site_config
        self.source_id = site_config.site_id
        self._request_interval = site_config.min_request_interval_ms / 1000.0
        self._last_request_time = 0.0
        self._s3 = None

    @property
    def s3(self):
        """Lazy-init S3 client."""
        if self._s3 is None:
            self._s3 = boto3.client(
                "s3",
                region_name=AWS_REGION,
                aws_access_key_id=AWS_ACCESS_KEY_ID,
                aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
            )
        return self._s3

    def throttle(self):
        """Enforce minimum delay between requests."""
        now = time.time()
        elapsed = now - self._last_request_time
        if elapsed < self._request_interval:
            time.sleep(self._request_interval - elapsed)
        self._last_request_time = time.time()

    @abstractmethod
    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        """
        Scrape the site and yield RawScrapedEvent objects.

        Implementations should:
        - Call self.throttle() before each HTTP request
        - Yield events as they're found (don't batch)
        - Handle pagination internally
        - Raise on fatal errors, log and continue on per-event errors
        """
        ...

    async def run(self) -> list[RawScrapedEvent]:
        """Run the scraper and collect all events."""
        events = []
        try:
            async for event in self.scrape():
                events.append(event)
                logger.info(f"[{self.source_id}] Scraped: {event.title[:60]}")
        except Exception as e:
            logger.error(f"[{self.source_id}] Scraper failed: {e}")
            raise
        logger.info(f"[{self.source_id}] Finished: {len(events)} events scraped")
        return events

    # --- S3 helpers ---

    def upload_raw_event(self, event: RawScrapedEvent):
        """Upload a single raw event JSON to S3."""
        h = event_hash(event.source_id, event.source_event_id)
        key = f"{S3_V2_PREFIX}events/{event.source_id}/{h}.json"
        try:
            self.s3.put_object(
                Bucket=S3_BUCKET,
                Key=key,
                Body=event.model_dump_json(indent=2),
                ContentType="application/json",
            )
            logger.debug(f"Uploaded raw event: {key}")
        except Exception as e:
            logger.error(f"Failed to upload raw event {key}: {e}")

    def upload_manifest(self, events: list[EnrichedEvent]):
        """Upload a source manifest (event index) to S3."""
        manifest = SourceManifest(
            source_id=self.source_id,
            source_name=self.site_config.name,
            total_events=len(events),
            events=events,
        )
        key = f"{S3_V2_PREFIX}manifests/{self.source_id}/latest.json"
        try:
            self.s3.put_object(
                Bucket=S3_BUCKET,
                Key=key,
                Body=manifest.model_dump_json(indent=2),
                ContentType="application/json",
            )
            logger.info(f"Uploaded manifest: {key} ({len(events)} events)")
        except Exception as e:
            logger.error(f"Failed to upload manifest {key}: {e}")

    def load_existing_hashes(self) -> set[str]:
        """Load existing event hashes from S3 manifest for deduplication."""
        key = f"{S3_V2_PREFIX}manifests/{self.source_id}/latest.json"
        try:
            resp = self.s3.get_object(Bucket=S3_BUCKET, Key=key)
            data = json.loads(resp["Body"].read())
            return {
                event_hash(e["source_id"], e["source_event_id"])
                for e in data.get("events", [])
            }
        except Exception:
            return set()
