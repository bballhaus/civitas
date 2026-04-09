"""
PlanetBids scraper — structured Playwright scraper (Tier 2).

PlanetBids is used by many California cities and counties. Each agency has
its own subdomain (e.g., pbsystem.planetbids.com/portal/XXXX/portal-home).

This is a structured scraper because PlanetBids has a consistent UI across
all agencies — same table layout, same pagination, same selectors.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import AsyncIterator

from playwright.async_api import async_playwright, Page

from webscraping.v2.models import RawScrapedEvent, ContactInfo, SiteConfig
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)

# Known California agencies on PlanetBids
PLANETBIDS_AGENCIES: dict[str, dict] = {
    "planetbids_santaclara_county": {
        "portal_id": "25060",
        "name": "County of Santa Clara",
        "url": "https://pbsystem.planetbids.com/portal/25060/portal-home",
    },
    "planetbids_sanmateo_county": {
        "portal_id": "25061",
        "name": "County of San Mateo",
        "url": "https://pbsystem.planetbids.com/portal/25061/portal-home",
    },
    "planetbids_santabarbara": {
        "portal_id": "25070",
        "name": "City of Santa Barbara",
        "url": "https://pbsystem.planetbids.com/portal/25070/portal-home",
    },
    "planetbids_sanjose": {
        "portal_id": "25063",
        "name": "City of San Jose",
        "url": "https://pbsystem.planetbids.com/portal/25063/portal-home",
    },
    "planetbids_sunnyvale": {
        "portal_id": "25064",
        "name": "City of Sunnyvale",
        "url": "https://pbsystem.planetbids.com/portal/25064/portal-home",
    },
    "planetbids_mountainview": {
        "portal_id": "25065",
        "name": "City of Mountain View",
        "url": "https://pbsystem.planetbids.com/portal/25065/portal-home",
    },
    "planetbids_paloalto": {
        "portal_id": "25066",
        "name": "City of Palo Alto",
        "url": "https://pbsystem.planetbids.com/portal/25066/portal-home",
    },
    "planetbids_redwoodcity": {
        "portal_id": "25067",
        "name": "City of Redwood City",
        "url": "https://pbsystem.planetbids.com/portal/25067/portal-home",
    },
    "planetbids_sanramon": {
        "portal_id": "25068",
        "name": "City of San Ramon",
        "url": "https://pbsystem.planetbids.com/portal/25068/portal-home",
    },
    "planetbids_dublin": {
        "portal_id": "25069",
        "name": "City of Dublin",
        "url": "https://pbsystem.planetbids.com/portal/25069/portal-home",
    },
    "planetbids_pleasanton": {
        "portal_id": "25071",
        "name": "City of Pleasanton",
        "url": "https://pbsystem.planetbids.com/portal/25071/portal-home",
    },
    "planetbids_hayward": {
        "portal_id": "25072",
        "name": "City of Hayward",
        "url": "https://pbsystem.planetbids.com/portal/25072/portal-home",
    },
}


class PlanetBidsScraper(BaseScraper):
    """
    Playwright-based scraper for PlanetBids portals.

    PlanetBids uses an Angular-based SPA with a consistent table layout
    across all portals. The portal_id in the URL is the only difference.
    """

    def __init__(self, site_config: SiteConfig):
        super().__init__(site_config)
        self._portal_url = site_config.config.get("url", site_config.url)
        self._agency_name = site_config.config.get("name", site_config.name)

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        """Scrape open bids from a PlanetBids portal."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
                ),
            )
            page = await context.new_page()

            try:
                logger.info(f"Loading PlanetBids portal: {self._agency_name}")
                await page.goto(self._portal_url, wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(5000)

                # Click "Open Bids" or "Current Solicitations" tab
                open_bids_tab = await page.query_selector(
                    'a[href*="bo-search"], button:has-text("Open"), '
                    'a:has-text("Open Bids"), a:has-text("Current")'
                )
                if open_bids_tab:
                    await open_bids_tab.click()
                    await page.wait_for_load_state("networkidle", timeout=15000)
                    await page.wait_for_timeout(3000)

                # Extract bids from the table
                page_num = 0
                while page_num < 20:
                    rows = await page.query_selector_all(
                        'table tbody tr, .bid-list-item, .solicitation-row'
                    )

                    if not rows:
                        # Try alternative selectors for different PlanetBids versions
                        rows = await page.query_selector_all(
                            '[class*="bid"] tr, [class*="solicitation"] tr'
                        )

                    if not rows:
                        logger.info("No bid rows found")
                        break

                    logger.info(f"Page {page_num + 1}: {len(rows)} rows")

                    for row in rows:
                        try:
                            event = await self._extract_row(page, row)
                            if event:
                                yield event
                        except Exception as e:
                            logger.debug(f"Failed to extract row: {e}")

                    # Try pagination
                    next_btn = await page.query_selector(
                        'button:has-text("Next"), a:has-text("Next"), '
                        '.pagination .next, [aria-label="Next"]'
                    )
                    if not next_btn or not await next_btn.is_visible():
                        break

                    disabled = await next_btn.get_attribute("disabled")
                    cls = await next_btn.get_attribute("class") or ""
                    if disabled or "disabled" in cls:
                        break

                    self.throttle()
                    await next_btn.click()
                    await page.wait_for_load_state("networkidle", timeout=15000)
                    await page.wait_for_timeout(2000)
                    page_num += 1

            finally:
                await browser.close()

    async def _extract_row(self, page: Page, row) -> RawScrapedEvent | None:
        """Extract a single bid from a table row."""
        # Get all text cells
        cells = await row.query_selector_all("td")
        if not cells:
            return None

        # Try to find title link
        title_link = await row.query_selector("a")
        if not title_link:
            return None

        title = (await title_link.inner_text()).strip()
        if not title:
            return None

        href = await title_link.get_attribute("href") or ""
        if href and not href.startswith("http"):
            base = page.url.split("/portal/")[0] if "/portal/" in page.url else page.url
            href = f"{base}{href}"

        # Extract text from all cells
        cell_texts = []
        for cell in cells:
            text = (await cell.inner_text()).strip()
            cell_texts.append(text)

        # Find date-like values (MM/DD/YYYY or YYYY-MM-DD)
        dates = []
        for text in cell_texts:
            date_match = re.search(r'\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}', text)
            if date_match:
                dates.append(date_match.group(0))

        # Find bid number (alphanumeric with dashes)
        bid_number = ""
        for text in cell_texts:
            if re.match(r'^[A-Z0-9][-A-Z0-9]{3,}$', text.strip(), re.IGNORECASE):
                bid_number = text.strip()
                break

        due_date = dates[-1] if dates else None
        event_id = bid_number or title[:50]

        return RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=event_id,
            source_url=href,
            title=title,
            issuing_agency=self._agency_name,
            due_date=due_date,
            posted_date=dates[0] if dates else None,
            procurement_type="Bid",
        )


# ---------------------------------------------------------------------------
# Helper: generate SiteConfig entries
# ---------------------------------------------------------------------------

def get_planetbids_site_configs() -> dict[str, SiteConfig]:
    """Generate SiteConfig entries for all known PlanetBids agencies."""
    configs = {}
    for site_id, agency in PLANETBIDS_AGENCIES.items():
        configs[site_id] = SiteConfig(
            site_id=site_id,
            name=agency["name"],
            url=agency["url"],
            scraper_type="structured",
            min_request_interval_ms=3000,
            config={
                "url": agency["url"],
                "name": agency["name"],
                "portal_id": agency["portal_id"],
            },
        )
    return configs


# ---------------------------------------------------------------------------
# Standalone runner
# ---------------------------------------------------------------------------

async def main():
    """Test the PlanetBids scraper."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    configs = get_planetbids_site_configs()
    first_id = next(iter(configs))
    config = configs[first_id]

    scraper = PlanetBidsScraper(config)
    events = await scraper.run()

    print(f"\nScraped {len(events)} events from {config.name}")
    for e in events[:5]:
        print(f"  - {e.title[:60]}")


if __name__ == "__main__":
    asyncio.run(main())
