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
# Verified PlanetBids portal IDs (discovered via agentic scraper + manual research)
# URL format: https://vendors.planetbids.com/portal/{portal_id}/bo/bo-search
PLANETBIDS_AGENCIES: dict[str, dict] = {
    "planetbids_san_diego": {
        "portal_id": "17950",
        "name": "City of San Diego",
        "url": "https://vendors.planetbids.com/portal/17950/bo/bo-search",
    },
    # Additional agencies to be discovered — use the agentic scraper to find
    # their portal IDs by navigating their procurement pages and seeing if
    # they redirect to vendors.planetbids.com/portal/{id}/...
    #
    # To discover a new PlanetBids agency:
    #   python -m webscraping.v2.scrapers.agentic <agency_procurement_url> <site_id>
    # The agentic scraper will follow links and reveal the PlanetBids portal ID.
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
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--single-process",
                ],
            )
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
                ),
                locale="en-US",
            )
            await context.add_init_script(
                'Object.defineProperty(navigator, "webdriver", {get: () => undefined});'
            )
            page = await context.new_page()

            try:
                # Navigate directly to the bid search page
                search_url = self._portal_url
                if "bo-search" not in search_url:
                    # If given a portal-home URL, convert to bo-search
                    search_url = search_url.replace("portal-home", "bo/bo-search")

                logger.info(f"Loading PlanetBids: {self._agency_name} ({search_url})")
                await page.goto(search_url, wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(5000)

                # Wait for the table to appear
                try:
                    await page.wait_for_selector("table tbody tr", timeout=10000)
                except Exception:
                    logger.info("No table found immediately, checking for tab navigation...")
                    open_bids_tab = await page.query_selector(
                        'a[href*="bo-search"], a:has-text("Open Bids"), a:has-text("Bid Opportunities")'
                    )
                    if open_bids_tab:
                        href = await open_bids_tab.get_attribute("href")
                        if href:
                            await page.goto(href if href.startswith("http") else f"https://vendors.planetbids.com{href}",
                                          wait_until="networkidle", timeout=30000)
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

                    # Try pagination — PlanetBids may use buttons, scroll, or no pagination
                    next_btn = None
                    for sel in ['.pagination .next', '[aria-label="Next"]', 'button.next-page']:
                        next_btn = await page.query_selector(sel)
                        if next_btn and await next_btn.is_visible():
                            break
                        next_btn = None

                    # Also try finding a "Next" button/link by evaluating JS (avoids has-text timeout)
                    if not next_btn:
                        has_next = await page.evaluate("""() => {
                            const els = Array.from(document.querySelectorAll('button, a'));
                            const next = els.find(el => el.textContent.trim() === 'Next' || el.textContent.trim() === '>');
                            return next ? true : false;
                        }""")
                        if has_next:
                            await page.evaluate("""() => {
                                const els = Array.from(document.querySelectorAll('button, a'));
                                const next = els.find(el => el.textContent.trim() === 'Next' || el.textContent.trim() === '>');
                                if (next) next.click();
                            }""")
                            await page.wait_for_timeout(3000)
                            page_num += 1
                            self.throttle()
                            continue

                    if not next_btn:
                        # Try scrolling to load more (infinite scroll)
                        prev_count = len(rows)
                        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                        await page.wait_for_timeout(3000)
                        new_rows = await page.query_selector_all('table tbody tr')
                        if len(new_rows) <= prev_count:
                            break  # No more rows loaded
                        page_num += 1
                        self.throttle()
                        continue

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
        cells = await row.query_selector_all("td")
        if not cells or len(cells) < 3:
            return None

        # Extract text from all cells
        cell_texts = []
        for cell in cells:
            text = (await cell.inner_text()).strip()
            cell_texts.append(text)

        # PlanetBids standard layout: posted, title, invitation#, due_date, remaining, stage, format
        # But layout varies — use heuristics
        title = ""
        bid_number = ""
        posted_date = None
        due_date = None
        detail_url = ""

        # Check for a link in any cell (for detail URL)
        title_link = await row.query_selector("a")
        if title_link:
            title = (await title_link.inner_text()).strip()
            href = await title_link.get_attribute("href") or ""
            if href and not href.startswith("http"):
                base = f"{page.url.split('/')[0]}//{page.url.split('/')[2]}"
                detail_url = f"{base}{href}"
            else:
                detail_url = href

        # If no link found, title is the longest non-date cell
        if not title:
            best = ""
            for text in cell_texts:
                if len(text) > len(best) and not re.match(r'^\d{1,2}/\d{1,2}/\d{2,4}', text):
                    best = text
            title = best

        if not title:
            return None

        # Extract dates
        dates = []
        for text in cell_texts:
            m = re.search(r'\d{1,2}/\d{1,2}/\d{2,4}(?:\s+\d{1,2}:\d{2}(?:am|pm)?)?', text, re.IGNORECASE)
            if m:
                dates.append(m.group(0))

        # Extract bid/invitation number (alphanumeric with dashes, 5+ chars)
        for text in cell_texts:
            if re.match(r'^[A-Z0-9][-A-Z0-9]{4,}$', text.strip(), re.IGNORECASE):
                bid_number = text.strip()
                break

        posted_date = dates[0] if dates else None
        due_date = dates[1] if len(dates) > 1 else (dates[0] if dates else None)
        event_id = bid_number or title[:50]

        return RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=event_id,
            source_url=detail_url or page.url,
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
