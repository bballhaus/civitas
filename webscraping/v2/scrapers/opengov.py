"""
OpenGov Procurement scraper — multi-tenant Tier-2 structured scraper.

OpenGov Procurement (formerly ProcureNow) is a SaaS platform many CA
cities have migrated onto. Each agency lives at
`https://procurement.opengov.com/portal/{slug}` with a near-identical
DOM, so a single scraper covers many agencies.

Sites are added by appending an entry to OPENGOV_AGENCIES; the runner
picks them up automatically through `get_opengov_site_configs`.

## Cloudflare bypass: ScrapingBee API mode

Every OpenGov portal sits behind Cloudflare bot detection. Headless
Chromium — even with stealth init scripts — does not pass the "Just a
moment" challenge. We bypass via ScrapingBee's API endpoint with
`render_js=true&stealth_proxy=true`, which returns the post-React-
hydration HTML. (The proxy endpoint at port 8886 does *not* expose
stealth_proxy mode, so a Playwright-via-proxy approach was tried and
abandoned.)

## Listing-only today

The OpenGov React app navigates to bid detail pages via Angular click
handlers — bid cards render as `<a href="#">` with the navigation hidden
in JS state. Until the detail-URL pattern is reverse-engineered (manual
DevTools inspection of the GraphQL/REST call fired on click, or an
Apollo-state parse), this scraper yields *listing-only* events:
title, agency, status, bid number, and the deadline if present on the
listing card. No description, no PDFs, no LLM enrichment.

Listing-only events still flow through the rest of the pipeline; the
attachment-enrichment pass is a no-op when `attachment_texts` is empty.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import AsyncIterator, Optional

from bs4 import BeautifulSoup

from webscraping.v2.config import fetch_via_scrapingbee, has_scrapingbee_key
from webscraping.v2.models import RawScrapedEvent, SiteConfig
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)


# CA agencies on OpenGov Procurement. Slug = the URL segment after /portal/.
# Add new entries as the discovery agent finds them.
OPENGOV_AGENCIES: dict[str, dict] = {
    "opengov_pasadena": {
        "slug": "pasadena",
        "name": "City of Pasadena",
        "url": "https://procurement.opengov.com/portal/pasadena",
    },
}


# How many bid cards to emit per Lambda invocation. OpenGov portals
# typically expose 5-30 active bids, so the whole portal usually fits
# in one invocation; the cap is defensive.
DEFAULT_BATCH_SIZE = 30


# Regex for the visible bid-number column on the listing. OpenGov
# renders these as plain text in a sibling cell to the title link, e.g.
# "2026-RFP-0123", "RFB-2026-007", "RFP-12345". The validator that
# consumes RawScrapedEvent only needs stable per-bid identity, not a
# clean format. Alternation order matters — the longer year-prefixed
# shapes must come first so they aren't shadowed by sub-matches.
_BID_NUMBER_RE = re.compile(
    r"\b(?:"
    r"\d{4}-[A-Z]{2,8}-[A-Z0-9-]+"        # 2026-RFP-0123
    r"|[A-Z]{2,8}-\d{4}-[A-Z0-9-]+"        # RFB-2026-007
    r"|[A-Z]{2,8}-?\d{3,}(?:-[A-Z0-9]+)?"  # RFP-12345 / RFP12345
    r")\b"
)


class OpenGovScraper(BaseScraper):
    """Multi-tenant OpenGov Procurement scraper (listing-only).

    Strategy:
    1. Fetch /portal/{slug} HTML through ScrapingBee API mode.
    2. Parse with BeautifulSoup; walk every visible bid card.
    3. Emit one RawScrapedEvent per card with whatever fields the
       listing exposes — title, bid number, agency, status, deadline.
       No detail-page navigation until OpenGov's React detail URLs are
       solved.
    """

    def __init__(
        self,
        site_config: SiteConfig,
        batch_offset: int = 0,
        batch_size: Optional[int] = None,
    ):
        super().__init__(site_config)
        cfg = site_config.config or {}
        self._slug: str = cfg.get("slug", "")
        self._agency_name: str = cfg.get("name", site_config.name)
        self._portal_url: str = cfg.get("url", site_config.url)
        self.batch_offset = batch_offset
        self.batch_size = batch_size or DEFAULT_BATCH_SIZE
        self.total_available: int = 0

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        if not has_scrapingbee_key():
            logger.warning(
                f"[{self.source_id}] No SCRAPINGBEE_API_KEY — Cloudflare "
                f"will block this run. Skipping."
            )
            return

        listing_url = self._portal_url.rstrip("/")
        logger.info(
            f"[{self.source_id}] Fetching listing via ScrapingBee API: "
            f"{listing_url}"
        )

        # ScrapingBee fetch is sync; offload so we don't block the loop
        # if a future caller runs multiple scrapers concurrently.
        try:
            html = await asyncio.to_thread(fetch_via_scrapingbee, listing_url)
        except Exception as e:
            logger.error(f"[{self.source_id}] ScrapingBee fetch failed: {e}")
            return

        cards = self._parse_listing(html)
        self.total_available = len(cards)
        logger.info(
            f"[{self.source_id}] Parsed {len(cards)} cards; "
            f"slicing [{self.batch_offset}:"
            f"{self.batch_offset + self.batch_size}]"
        )

        end = self.batch_offset + self.batch_size
        for card in cards[self.batch_offset:end]:
            event = self._card_to_event(card)
            if event is not None:
                yield event

    # ------------------------------------------------------------------
    # Listing parser
    # ------------------------------------------------------------------

    def _parse_listing(self, html: str) -> list[dict]:
        """Extract one dict per visible bid card from the rendered HTML.

        OpenGov's listing renders each bid as a row containing:
          - a title (link or heading text),
          - a sibling cell with the public bid number,
          - a status pill ("Open", "Closed", etc.),
          - a deadline timestamp.

        DOM markup varies subtly between agencies, so the parser is
        defensive: it walks anchor candidates and falls back to the
        nearest row container when the structured layout is missing.
        """
        soup = BeautifulSoup(html, "html.parser")
        cards: list[dict] = []
        seen_titles: set[str] = set()

        # OpenGov bid links currently render as <a href="#"> with the
        # title as text content. Filter to anchors that look like bid
        # rows: meaningful title length + a parent row with siblings.
        for anchor in soup.find_all("a"):
            title = (anchor.get_text(strip=True) or "").strip()
            if len(title) < 8 or len(title) > 240:
                continue
            # Reject anchors that are obviously chrome (nav, footer).
            if anchor.find_parent(["nav", "header", "footer"]):
                continue
            if title in seen_titles:
                continue

            row = self._row_container(anchor)
            row_text = row.get_text(" ", strip=True) if row else ""

            # A real bid card has either a recognizable bid number or a
            # status keyword in the surrounding row. Anchors that match
            # neither are usually navigation chrome that slipped through.
            bid_number = self._extract_bid_number(row_text)
            status = self._extract_status(row_text)
            if not bid_number and not status:
                continue

            seen_titles.add(title)
            cards.append(
                {
                    "title": title,
                    "bid_number": bid_number,
                    "status": status,
                    "deadline": self._extract_deadline(row_text),
                }
            )

        return cards

    @staticmethod
    def _row_container(anchor) -> Optional[object]:
        """Walk up to ~4 levels to find a row-like ancestor."""
        node = anchor
        for _ in range(4):
            node = node.parent
            if node is None:
                return None
            # Heuristic: a row contains the anchor plus at least one
            # sibling that holds the bid number / status.
            if len(node.find_all(string=True, recursive=True)) > 3:
                return node
        return node

    @staticmethod
    def _extract_bid_number(text: str) -> str:
        m = _BID_NUMBER_RE.search(text or "")
        return m.group(0).strip() if m else ""

    @staticmethod
    def _extract_status(text: str) -> str:
        lower = (text or "").lower()
        for status in ("open", "closed", "awarded", "cancelled", "draft"):
            # Word-boundary match so "Open" doesn't fire on "Opening".
            if re.search(rf"\b{status}\b", lower):
                return status.capitalize()
        return ""

    @staticmethod
    def _extract_deadline(text: str) -> str:
        # Pull the first date-ish token. Leave date normalization to the
        # enrichment pipeline so we keep the source format verbatim.
        m = re.search(
            r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*"
            r"\s+\d{1,2},?\s+\d{4}"
            r"(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))?",
            text or "",
        )
        if m:
            return m.group(0).strip()
        m = re.search(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b", text or "")
        return m.group(0).strip() if m else ""

    # ------------------------------------------------------------------
    # Event builder
    # ------------------------------------------------------------------

    def _card_to_event(self, card: dict) -> Optional[RawScrapedEvent]:
        title = (card.get("title") or "").strip()
        if not title:
            return None

        bid_number = (card.get("bid_number") or "").strip()
        # source_event_id must be stable across runs. Prefer the bid
        # number; fall back to the title (truncated) when absent.
        source_event_id = bid_number or title[:80]

        # Without a real detail URL, anchor the source URL with the bid
        # number so deduping doesn't collapse multiple bids onto the
        # same portal URL.
        source_url = self._portal_url.rstrip("/")
        if bid_number:
            source_url = f"{source_url}#bid={bid_number}"

        event = RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=source_event_id,
            source_url=source_url,
            title=title,
            issuing_agency=self._agency_name,
            due_date=card.get("deadline") or "",
            procurement_type="RFP",
            raw_metadata={
                "bid_number": bid_number,
                "status": card.get("status") or "",
                "listing_only": True,
            },
        )
        logger.info(
            f"[{self.source_id}] Listing card: {title[:60]} "
            f"(bid={bid_number or '?'}, status={card.get('status') or '?'})"
        )
        return event


# ---------------------------------------------------------------------------
# Helper: generate SiteConfig entries
# ---------------------------------------------------------------------------

_S3_REGISTRY_KEY = "scrapes/v2/registry/opengov.json"


def _load_registered_from_s3() -> dict[str, dict]:
    """Load any onboarded OpenGov agencies from S3.

    The onboarding pipeline writes vetted portals here so adding new
    agencies doesn't require a code deploy. Schema: same shape as
    OPENGOV_AGENCIES — a dict keyed by site_id of {slug, name, url}.

    Returns {} on any failure (missing object, no S3 access, parse error).
    """
    try:
        import json as _json
        from webscraping.v2.config import S3_BUCKET, get_s3_client
        s3 = get_s3_client()
        resp = s3.get_object(Bucket=S3_BUCKET, Key=_S3_REGISTRY_KEY)
        data = _json.loads(resp["Body"].read())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def get_opengov_site_configs() -> dict[str, SiteConfig]:
    """Generate SiteConfig entries for all known OpenGov agencies.

    Combines the in-code seed list (`OPENGOV_AGENCIES`) with any portals
    written to S3 by the onboarding pipeline. In-code entries win on
    site_id collision so emergency overrides still work via deploy.
    """
    merged: dict[str, dict] = {}
    merged.update(_load_registered_from_s3())
    merged.update(OPENGOV_AGENCIES)  # code wins

    configs: dict[str, SiteConfig] = {}
    for site_id, agency in merged.items():
        configs[site_id] = SiteConfig(
            site_id=site_id,
            name=agency["name"],
            url=agency["url"],
            scraper_type="structured",
            min_request_interval_ms=4000,
            config={
                "slug": agency.get("slug", ""),
                "name": agency["name"],
                "url": agency["url"],
            },
        )
    return configs


# ---------------------------------------------------------------------------
# Standalone runner
# ---------------------------------------------------------------------------

async def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    configs = get_opengov_site_configs()
    first_id = next(iter(configs))
    config = configs[first_id]

    scraper = OpenGovScraper(config)
    events = await scraper.run()

    print(f"\nScraped {len(events)} events from {config.name}")
    for e in events[:5]:
        print(f"  - {e.title[:60]}")
        print(f"    bid={e.raw_metadata.get('bid_number')!r}  "
              f"status={e.raw_metadata.get('status')!r}  "
              f"deadline={e.due_date!r}")


if __name__ == "__main__":
    asyncio.run(main())
