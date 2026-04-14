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

# Known California agencies on PlanetBids (44 verified portals)
PLANETBIDS_AGENCIES: dict[str, dict] = {
    # --- Cities ---
    "planetbids_san_diego": {
        "portal_id": "17950",
        "name": "City of San Diego",
        "url": "https://vendors.planetbids.com/portal/17950/bo/bo-search",
    },
    "planetbids_sacramento": {
        "portal_id": "15300",
        "name": "City of Sacramento",
        "url": "https://vendors.planetbids.com/portal/15300/bo/bo-search",
    },
    # Long Beach portal 15810 is deactivated (redirects to error page).
    # Port of Long Beach (19236) is still active and listed below.
    "planetbids_riverside": {
        "portal_id": "39475",
        "name": "City of Riverside",
        "url": "https://vendors.planetbids.com/portal/39475/bo/bo-search",
    },
    "planetbids_santa_ana": {
        "portal_id": "20137",
        "name": "City of Santa Ana",
        "url": "https://vendors.planetbids.com/portal/20137/bo/bo-search",
    },
    "planetbids_anaheim": {
        "portal_id": "14424",
        "name": "City of Anaheim",
        "url": "https://vendors.planetbids.com/portal/14424/bo/bo-search",
    },
    "planetbids_fresno": {
        "portal_id": "14769",
        "name": "City of Fresno",
        "url": "https://vendors.planetbids.com/portal/14769/bo/bo-search",
    },
    "planetbids_glendale": {
        "portal_id": "39503",
        "name": "City of Glendale",
        "url": "https://vendors.planetbids.com/portal/39503/bo/bo-search",
    },
    "planetbids_fontana": {
        "portal_id": "14391",
        "name": "City of Fontana",
        "url": "https://vendors.planetbids.com/portal/14391/bo/bo-search",
    },
    "planetbids_moreno_valley": {
        "portal_id": "24660",
        "name": "City of Moreno Valley",
        "url": "https://vendors.planetbids.com/portal/24660/bo/bo-search",
    },
    "planetbids_san_bernardino": {
        "portal_id": "39495",
        "name": "City of San Bernardino",
        "url": "https://vendors.planetbids.com/portal/39495/bo/bo-search",
    },
    "planetbids_bakersfield": {
        "portal_id": "14660",
        "name": "City of Bakersfield",
        "url": "https://vendors.planetbids.com/portal/14660/bo/bo-search",
    },
    "planetbids_torrance": {
        "portal_id": "47426",
        "name": "City of Torrance",
        "url": "https://vendors.planetbids.com/portal/47426/bo/bo-search",
    },
    "planetbids_pasadena": {
        "portal_id": "14770",
        "name": "City of Pasadena",
        "url": "https://vendors.planetbids.com/portal/14770/bo/bo-search",
    },
    "planetbids_downey": {
        "portal_id": "24661",
        "name": "City of Downey",
        "url": "https://vendors.planetbids.com/portal/24661/bo/bo-search",
    },
    "planetbids_costa_mesa": {
        "portal_id": "45476",
        "name": "City of Costa Mesa",
        "url": "https://vendors.planetbids.com/portal/45476/bo/bo-search",
    },
    "planetbids_inglewood": {
        "portal_id": "45619",
        "name": "City of Inglewood",
        "url": "https://vendors.planetbids.com/portal/45619/bo/bo-search",
    },
    "planetbids_pomona": {
        "portal_id": "24662",
        "name": "City of Pomona",
        "url": "https://vendors.planetbids.com/portal/24662/bo/bo-search",
    },
    "planetbids_burbank": {
        "portal_id": "14210",
        "name": "City of Burbank",
        "url": "https://vendors.planetbids.com/portal/14210/bo/bo-search",
    },
    "planetbids_norwalk": {
        "portal_id": "54783",
        "name": "City of Norwalk",
        "url": "https://vendors.planetbids.com/portal/54783/bo/bo-search",
    },
    "planetbids_carson": {
        "portal_id": "32461",
        "name": "City of Carson",
        "url": "https://vendors.planetbids.com/portal/32461/bo/bo-search",
    },
    "planetbids_chula_vista": {
        "portal_id": "15381",
        "name": "City of Chula Vista",
        "url": "https://vendors.planetbids.com/portal/15381/bo/bo-search",
    },
    "planetbids_rialto": {
        "portal_id": "28159",
        "name": "City of Rialto",
        "url": "https://vendors.planetbids.com/portal/28159/bo/bo-search",
    },
    "planetbids_jurupa_valley": {
        "portal_id": "26879",
        "name": "City of Jurupa Valley",
        "url": "https://vendors.planetbids.com/portal/26879/bo/bo-search",
    },
    "planetbids_corona": {
        "portal_id": "39497",
        "name": "City of Corona",
        "url": "https://vendors.planetbids.com/portal/39497/bo/bo-search",
    },
    "planetbids_el_cajon": {
        "portal_id": "14593",
        "name": "City of El Cajon",
        "url": "https://vendors.planetbids.com/portal/14593/bo/bo-search",
    },
    "planetbids_goleta": {
        "portal_id": "45299",
        "name": "City of Goleta",
        "url": "https://vendors.planetbids.com/portal/45299/bo/bo-search",
    },
    "planetbids_huntington_beach": {
        "portal_id": "15340",
        "name": "City of Huntington Beach",
        "url": "https://vendors.planetbids.com/portal/15340/bo/bo-search",
    },
    "planetbids_carlsbad": {
        "portal_id": "27970",
        "name": "City of Carlsbad",
        "url": "https://vendors.planetbids.com/portal/27970/bo/bo-search",
    },
    "planetbids_santa_fe_springs": {
        "portal_id": "65093",
        "name": "City of Santa Fe Springs",
        "url": "https://vendors.planetbids.com/portal/65093/bo/bo-search",
    },
    "planetbids_palm_springs": {
        "portal_id": "47688",
        "name": "City of Palm Springs",
        "url": "https://vendors.planetbids.com/portal/47688/bo/bo-search",
    },
    "planetbids_maywood": {
        "portal_id": "64496",
        "name": "City of Maywood",
        "url": "https://vendors.planetbids.com/portal/64496/bo/bo-search",
    },
    "planetbids_palmdale": {
        "portal_id": "23532",
        "name": "City of Palmdale",
        "url": "https://vendors.planetbids.com/portal/23532/bo/bo-search",
    },
    "planetbids_la_mesa": {
        "portal_id": "15382",
        "name": "City of La Mesa",
        "url": "https://vendors.planetbids.com/portal/15382/bo/bo-search",
    },
    "planetbids_san_marcos": {
        "portal_id": "39481",
        "name": "City of San Marcos",
        "url": "https://vendors.planetbids.com/portal/39481/bo/bo-search",
    },
    "planetbids_national_city": {
        "portal_id": "16151",
        "name": "City of National City",
        "url": "https://vendors.planetbids.com/portal/16151/bo/bo-search",
    },
    "planetbids_south_pasadena": {
        "portal_id": "44654",
        "name": "City of South Pasadena",
        "url": "https://vendors.planetbids.com/portal/44654/bo/bo-search",
    },
    # --- Ports, transit, education, and regional agencies ---
    "planetbids_port_long_beach": {
        "portal_id": "19236",
        "name": "Port of Long Beach",
        "url": "https://vendors.planetbids.com/portal/19236/bo/bo-search",
    },
    "planetbids_port_san_diego": {
        "portal_id": "13982",
        "name": "Port of San Diego",
        "url": "https://vendors.planetbids.com/portal/13982/bo/bo-search",
    },
    "planetbids_bgp_airport": {
        "portal_id": "21910",
        "name": "Burbank-Glendale-Pasadena Airport Authority",
        "url": "https://vendors.planetbids.com/portal/21910/bo/bo-search",
    },
    "planetbids_riverside_transit": {
        "portal_id": "55483",
        "name": "Riverside Transit Agency",
        "url": "https://vendors.planetbids.com/portal/55483/bo/bo-search",
    },
    "planetbids_scag": {
        "portal_id": "14434",
        "name": "Southern California Association of Governments",
        "url": "https://vendors.planetbids.com/portal/14434/bo/bo-search",
    },
    "planetbids_csu_fresno": {
        "portal_id": "26037",
        "name": "CSU Fresno",
        "url": "https://vendors.planetbids.com/portal/26037/bo/bo-search",
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
        # PlanetBids uses Ember.js — rows have CSS classes (.title, .invitationNum)
        # and typically NO <a> links. Extract by class first, fall back to heuristics.
        cells = await row.query_selector_all("td")
        if not cells:
            return None

        # Try class-based extraction (PlanetBids Ember layout)
        title = ""
        title_cell = await row.query_selector("td.title")
        if title_cell:
            title = (await title_cell.inner_text()).strip()

        bid_number = ""
        inv_cell = await row.query_selector("td.invitationNum")
        if inv_cell:
            bid_number = (await inv_cell.inner_text()).strip()

        # Fall back to <a> link if present (older PlanetBids versions)
        if not title:
            title_link = await row.query_selector("a")
            if title_link:
                title = (await title_link.inner_text()).strip()

        if not title:
            return None

        # Build detail URL from the row's data-itemid or the portal URL
        detail_url = page.url
        item_cell = await row.query_selector("td[data-itemid]")
        if item_cell:
            item_id = await item_cell.get_attribute("data-itemid")
            if item_id:
                portal_base = page.url.split("/bo/")[0] if "/bo/" in page.url else page.url
                detail_url = f"{portal_base}/bo/bo-detail/{item_id}"

        # Extract text from all cells for date parsing
        cell_texts = []
        for cell in cells:
            text = (await cell.inner_text()).strip()
            cell_texts.append(text)

        # Find dates (MM/DD/YYYY)
        dates = []
        for text in cell_texts:
            date_match = re.search(r'\d{1,2}/\d{1,2}/\d{2,4}', text)
            if date_match:
                dates.append(date_match.group(0))

        # Find bid number from cell text if not found by class
        if not bid_number:
            for text in cell_texts:
                if re.match(r'^[A-Z0-9][-A-Z0-9]{3,}$', text.strip(), re.IGNORECASE):
                    bid_number = text.strip()
                    break

        event_id = bid_number or title[:50]
        posted_date = dates[0] if dates else None
        due_date = dates[1] if len(dates) > 1 else (dates[0] if dates else None)

        return RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=event_id,
            source_url=detail_url,
            title=title,
            issuing_agency=self._agency_name,
            due_date=due_date,
            posted_date=posted_date,
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
