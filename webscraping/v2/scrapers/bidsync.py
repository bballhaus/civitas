"""
BidSync/Periscope scraper — API-based (Tier 1).

BidSync (now Periscope by Proactis) is used by many California counties and
cities. It provides a structured search interface that we can query via HTTP.

One scraper instance handles ALL BidSync-powered agencies — each agency is
just a different `buyerId` parameter.

Agencies using BidSync include:
- City of Fresno, City of Bakersfield, City of Long Beach
- County of Riverside, County of San Bernardino
- Many school districts, water districts, transit agencies
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import AsyncIterator
from urllib.parse import urlencode

import httpx

from webscraping.v2.models import RawScrapedEvent, ContactInfo, SiteConfig
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)

# Base URLs for BidSync search
BIDSYNC_SEARCH_URL = "https://www.bidsync.com/DPXViewer/BidSearch"
BIDSYNC_BID_DETAIL = "https://www.bidsync.com/DPXViewer/BidDetail"

# Known California agencies on BidSync with their buyer IDs
# These can be discovered by searching on bidsync.com
BIDSYNC_AGENCIES: dict[str, dict] = {
    "bidsync_fresno": {
        "buyer_id": "46053",
        "name": "City of Fresno",
        "state": "CA",
    },
    "bidsync_bakersfield": {
        "buyer_id": "46009",
        "name": "City of Bakersfield",
        "state": "CA",
    },
    "bidsync_longbeach": {
        "buyer_id": "46037",
        "name": "City of Long Beach",
        "state": "CA",
    },
    "bidsync_riverside_county": {
        "buyer_id": "46065",
        "name": "County of Riverside",
        "state": "CA",
    },
    "bidsync_sanbernardino_county": {
        "buyer_id": "46071",
        "name": "County of San Bernardino",
        "state": "CA",
    },
    "bidsync_stockton": {
        "buyer_id": "46077",
        "name": "City of Stockton",
        "state": "CA",
    },
    "bidsync_modesto": {
        "buyer_id": "46099",
        "name": "City of Modesto",
        "state": "CA",
    },
    "bidsync_oxnard": {
        "buyer_id": "46111",
        "name": "City of Oxnard",
        "state": "CA",
    },
    "bidsync_fontana": {
        "buyer_id": "46071b",
        "name": "City of Fontana",
        "state": "CA",
    },
    "bidsync_moreno_valley": {
        "buyer_id": "46065b",
        "name": "City of Moreno Valley",
        "state": "CA",
    },
    "bidsync_pomona": {
        "buyer_id": "46037b",
        "name": "City of Pomona",
        "state": "CA",
    },
    "bidsync_palmdale": {
        "buyer_id": "46037c",
        "name": "City of Palmdale",
        "state": "CA",
    },
    "bidsync_escondido": {
        "buyer_id": "46073",
        "name": "City of Escondido",
        "state": "CA",
    },
    "bidsync_torrance": {
        "buyer_id": "46037d",
        "name": "City of Torrance",
        "state": "CA",
    },
    "bidsync_pasadena": {
        "buyer_id": "46037e",
        "name": "City of Pasadena",
        "state": "CA",
    },
}


class BidSyncScraper(BaseScraper):
    """
    Scrapes open bids from a BidSync-powered agency.

    Uses HTTP requests to the BidSync search/detail pages — no browser needed.
    The site_config.config dict should contain:
      - buyer_id: the BidSync buyer ID for this agency
      - name: the agency name
    """

    def __init__(self, site_config: SiteConfig):
        super().__init__(site_config)
        self._buyer_id = site_config.config.get("buyer_id", "")
        self._agency_name = site_config.config.get("name", site_config.name)

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        """Query BidSync for open bids and yield events."""
        async with httpx.AsyncClient(
            timeout=30.0,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
                ),
            },
        ) as client:
            page = 1
            total_yielded = 0

            while total_yielded < 500:
                self.throttle()

                # Build search URL
                params = {
                    "buyerId": self._buyer_id,
                    "status": "open",
                    "page": str(page),
                    "pageSize": "50",
                    "state": "CA",
                }

                try:
                    url = f"{BIDSYNC_SEARCH_URL}?{urlencode(params)}"
                    logger.info(f"Fetching BidSync page {page} for {self._agency_name}")
                    resp = await client.get(url)

                    if resp.status_code != 200:
                        logger.warning(f"BidSync returned {resp.status_code}")
                        break

                    # Parse the HTML response to extract bid listings
                    html = resp.text
                    events = self._parse_search_results(html)

                    if not events:
                        break

                    for event in events:
                        yield event
                        total_yielded += 1

                    page += 1

                except Exception as e:
                    logger.error(f"BidSync request failed: {e}")
                    break

    def _parse_search_results(self, html: str) -> list[RawScrapedEvent]:
        """Parse BidSync search results HTML into events."""
        events = []

        # BidSync uses a structured HTML format with bid cards
        # Extract bid entries using regex (light parsing, no heavy dependency)
        bid_pattern = re.compile(
            r'bid[_-]?id["\s:=]+["\']?(\d+)["\']?.*?'
            r'(?:title|name)["\s:>]+([^<"]+?)(?:<|")',
            re.IGNORECASE | re.DOTALL,
        )

        # Also try to find structured data in JSON format (some BidSync pages embed it)
        json_match = re.search(r'var\s+bidData\s*=\s*(\[.*?\]);', html, re.DOTALL)
        if json_match:
            try:
                bids = json.loads(json_match.group(1))
                for bid in bids:
                    events.append(self._bid_to_event(bid))
                return events
            except json.JSONDecodeError:
                pass

        # Fallback: parse HTML table/card format
        # Look for bid rows with title, date, bid number
        row_pattern = re.compile(
            r'<tr[^>]*class="[^"]*bid[^"]*"[^>]*>(.*?)</tr>',
            re.IGNORECASE | re.DOTALL,
        )

        for row_match in row_pattern.finditer(html):
            row_html = row_match.group(1)
            try:
                event = self._parse_bid_row(row_html)
                if event:
                    events.append(event)
            except Exception as e:
                logger.debug(f"Failed to parse bid row: {e}")

        return events

    def _bid_to_event(self, bid: dict) -> RawScrapedEvent:
        """Convert a BidSync JSON bid object to RawScrapedEvent."""
        bid_id = str(bid.get("bidId", bid.get("id", "")))
        title = bid.get("title", bid.get("bidTitle", ""))
        description = bid.get("description", bid.get("shortDescription", ""))

        return RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=bid_id,
            source_url=f"{BIDSYNC_BID_DETAIL}?bidId={bid_id}",
            title=title,
            description=description,
            issuing_agency=self._agency_name,
            posted_date=bid.get("publishDate", bid.get("openDate")),
            due_date=bid.get("closeDate", bid.get("dueDate")),
            contact=ContactInfo(
                name=bid.get("contactName"),
                email=bid.get("contactEmail"),
                phone=bid.get("contactPhone"),
            ),
            procurement_type=bid.get("bidType", "Bid"),
            raw_metadata=bid,
        )

    def _parse_bid_row(self, row_html: str) -> RawScrapedEvent | None:
        """Parse a single bid table row from HTML."""
        # Extract title from link
        title_match = re.search(r'<a[^>]*>([^<]+)</a>', row_html)
        if not title_match:
            return None

        title = title_match.group(1).strip()
        if not title:
            return None

        # Extract bid ID from link href
        bid_id_match = re.search(r'bidId=(\d+)', row_html)
        bid_id = bid_id_match.group(1) if bid_id_match else title[:30]

        # Extract dates (look for date patterns)
        dates = re.findall(r'\d{1,2}/\d{1,2}/\d{2,4}', row_html)
        due_date = dates[-1] if dates else None

        return RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=bid_id,
            source_url=f"{BIDSYNC_BID_DETAIL}?bidId={bid_id}",
            title=title,
            issuing_agency=self._agency_name,
            due_date=due_date,
            procurement_type="Bid",
        )


# ---------------------------------------------------------------------------
# Helper: generate SiteConfig entries for all known BidSync agencies
# ---------------------------------------------------------------------------

def get_bidsync_site_configs() -> dict[str, SiteConfig]:
    """Generate SiteConfig entries for all known BidSync agencies."""
    configs = {}
    for site_id, agency in BIDSYNC_AGENCIES.items():
        configs[site_id] = SiteConfig(
            site_id=site_id,
            name=agency["name"],
            url=BIDSYNC_SEARCH_URL,
            scraper_type="api",
            min_request_interval_ms=2000,
            config={
                "buyer_id": agency["buyer_id"],
                "name": agency["name"],
            },
        )
    return configs


# ---------------------------------------------------------------------------
# Standalone runner
# ---------------------------------------------------------------------------

async def main():
    """Test the BidSync scraper."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    configs = get_bidsync_site_configs()
    # Test with first agency
    first_id = next(iter(configs))
    config = configs[first_id]

    scraper = BidSyncScraper(config)
    events = await scraper.run()

    print(f"\nScraped {len(events)} events from {config.name}")
    for e in events[:5]:
        print(f"  - {e.title[:60]}")


if __name__ == "__main__":
    asyncio.run(main())
