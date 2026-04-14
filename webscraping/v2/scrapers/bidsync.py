"""
BidSync/Periscope scraper — structured Playwright scraper (Tier 2).

BidSync (now Periscope by Proactis) is used by many California counties and
cities. The platform runs a JSF-based web app with an Advanced Search page
that can filter by state and product type.

The old DPX search API is dead (returns 404). This scraper uses Playwright
to interact with the JSF-based Advanced Search form.

One scraper instance searches ALL California bids via Advanced Search, then
attributes each result to the correct agency based on the organization name
in the search results.

Agencies using BidSync include:
- City of Long Beach, City of Hayward, City of Berkeley, City of Palo Alto
- County of Orange, County of Santa Clara, County of Solano, County of Ventura
- Contra Costa County, Shasta County
- Orange County Fire Authority, SMUD, SFMTA, SCVWD, LAUSD
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import AsyncIterator

from playwright.async_api import async_playwright, Page, TimeoutError as PlaywrightTimeout

from webscraping.v2.models import RawScrapedEvent, ContactInfo, SiteConfig
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)

# BidSync URLs
BIDSYNC_ADVANCED_SEARCH = "https://www.bidsync.com/bidsync-app-web/shared/shared/advancedSearch.xhtml"
BIDSYNC_SEARCH_RESULTS = "https://www.bidsync.com/bidsync-app-web/shared/shared/searchResults.xhtml"
BIDSYNC_BID_DETAIL = "https://www.bidsync.com/bidsync-app-web/vendor/links/BidDetail.xhtml?bidid={bid_id}"

# Known California agencies on BidSync with their organization IDs
BIDSYNC_AGENCIES: dict[str, dict] = {
    "bidsync_long_beach": {"org_id": "28130", "name": "City of Long Beach"},
    "bidsync_hayward": {"org_id": "31189", "name": "City of Hayward"},
    "bidsync_berkeley": {"org_id": "579179", "name": "City of Berkeley"},
    "bidsync_palo_alto": {"org_id": "1486625", "name": "City of Palo Alto"},
    "bidsync_orange_county": {"org_id": "373346", "name": "County of Orange"},
    "bidsync_santa_clara_county": {"org_id": "132102", "name": "County of Santa Clara"},
    "bidsync_solano_county": {"org_id": "318791", "name": "County of Solano"},
    "bidsync_ventura_county": {"org_id": "1511892", "name": "County of Ventura"},
    "bidsync_contra_costa_county": {"org_id": "25948", "name": "Contra Costa County"},
    "bidsync_shasta_county": {"org_id": "1556077", "name": "Shasta County"},
    "bidsync_orange_county_fire": {"org_id": "31086", "name": "Orange County Fire Authority"},
    "bidsync_smud": {"org_id": "156036", "name": "Sacramento Municipal Utility District"},
    "bidsync_sfmta": {"org_id": "343048", "name": "SF Municipal Transportation Agency"},
    "bidsync_scvwd": {"org_id": "1981894", "name": "Santa Clara Valley Water District"},
    "bidsync_lausd": {"org_id": "101762", "name": "LAUSD"},
}

# Build a reverse lookup: lowercase agency name fragment -> site_id
_AGENCY_NAME_TO_SITE_ID: dict[str, str] = {}
for _sid, _info in BIDSYNC_AGENCIES.items():
    _AGENCY_NAME_TO_SITE_ID[_info["name"].lower()] = _sid


def _match_agency(org_name: str) -> tuple[str, str]:
    """
    Match an organization name from search results to a known agency.

    Returns (site_id, canonical_name). If no match, returns a generated
    site_id based on the org name and the org name itself.
    """
    org_lower = org_name.strip().lower()
    # Exact match first
    for name_lower, site_id in _AGENCY_NAME_TO_SITE_ID.items():
        if name_lower == org_lower:
            return site_id, BIDSYNC_AGENCIES[site_id]["name"]
    # Substring match (agency name contained in result org name, or vice versa)
    for name_lower, site_id in _AGENCY_NAME_TO_SITE_ID.items():
        if name_lower in org_lower or org_lower in name_lower:
            return site_id, BIDSYNC_AGENCIES[site_id]["name"]
    # No match — generate a site_id from the org name
    slug = re.sub(r'[^a-z0-9]+', '_', org_lower).strip('_')
    return f"bidsync_{slug}", org_name.strip()


class BidSyncScraper(BaseScraper):
    """
    Playwright-based scraper for BidSync/Periscope Advanced Search.

    Loads the JSF Advanced Search page, submits a search for current
    California bids, and parses the results table. Handles pagination
    across multiple result pages.

    The site_config.config dict may contain:
      - org_id: (optional) filter to a specific agency's org ID
      - name: the agency name
      - mode: "all_ca" (default) to search all CA bids, or "single" for one agency
    """

    def __init__(self, site_config: SiteConfig):
        super().__init__(site_config)
        self._org_id = site_config.config.get("org_id", "")
        self._agency_name = site_config.config.get("name", site_config.name)
        self._mode = site_config.config.get("mode", "all_ca")

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        """Scrape open bids from BidSync Advanced Search."""
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
                # Step 1: Load Advanced Search page
                logger.info(f"Loading BidSync Advanced Search: {BIDSYNC_ADVANCED_SEARCH}")
                await page.goto(BIDSYNC_ADVANCED_SEARCH, wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(3000)

                # Step 2: Fill in the search form
                submitted = await self._fill_and_submit_search(page)
                if not submitted:
                    logger.warning("Failed to submit BidSync search form")
                    return

                # Step 3: Parse results and handle pagination
                page_num = 0
                max_pages = 50  # safety limit
                seen_ids: set[str] = set()

                while page_num < max_pages:
                    await page.wait_for_timeout(2000)

                    # Extract bids from current results page
                    events = await self._extract_results(page, seen_ids)

                    if not events:
                        if page_num == 0:
                            logger.info("No results found on BidSync search")
                        break

                    for event in events:
                        seen_ids.add(event.source_event_id)
                        yield event

                    logger.info(f"Page {page_num + 1}: extracted {len(events)} bids (total seen: {len(seen_ids)})")

                    # Try to go to next page
                    has_next = await self._go_to_next_page(page)
                    if not has_next:
                        break

                    page_num += 1
                    self.throttle()

            finally:
                await browser.close()

    async def _fill_and_submit_search(self, page: Page) -> bool:
        """
        Fill in the BidSync Advanced Search form and submit it.

        The JSF form has dropdowns for product type, region/state, and
        bid status. We select:
        - Product type: "State & Local" (if available)
        - Region: California
        - Status: Current/Open bids

        Returns True if the form was submitted successfully.
        """
        try:
            # Wait for the form to be present
            await page.wait_for_selector("form", timeout=15000)

            # Try to select "State & Local" product type
            # JSF forms often use <select> elements or PrimeFaces dropdowns
            await self._try_select_option(
                page,
                selectors=[
                    'select[id*="productType"]',
                    'select[id*="product"]',
                    'select[name*="productType"]',
                    'select[name*="product"]',
                ],
                value_patterns=["state", "local", "State & Local", "State and Local"],
            )

            # Try to set state/region to California
            await self._try_select_option(
                page,
                selectors=[
                    'select[id*="state"]',
                    'select[id*="region"]',
                    'select[name*="state"]',
                    'select[name*="region"]',
                ],
                value_patterns=["CA", "California", "california"],
            )

            # Try to select "Current" or "Open" bid status
            await self._try_select_option(
                page,
                selectors=[
                    'select[id*="status"]',
                    'select[id*="bidStatus"]',
                    'select[name*="status"]',
                ],
                value_patterns=["Current", "current", "Open", "open", "Active", "active"],
            )

            # If there's a keyword/search text field, we can leave it blank to get all results

            # Try clicking checkboxes for "Current Bids" or similar
            current_checkbox = await page.query_selector(
                'input[type="checkbox"][id*="current"], '
                'input[type="checkbox"][id*="Current"], '
                'input[type="checkbox"][id*="open"], '
                'input[type="checkbox"][value*="current"]'
            )
            if current_checkbox:
                is_checked = await current_checkbox.is_checked()
                if not is_checked:
                    await current_checkbox.click()
                    await page.wait_for_timeout(500)

            # Submit the search form
            # Look for a search/submit button
            submit_btn = None
            for sel in [
                'input[type="submit"][value*="Search"]',
                'button[type="submit"]',
                'input[type="submit"]',
                'a[id*="search" i]',
                'button[id*="search" i]',
                'input[value*="Search"]',
                'a:has-text("Search")',
                'button:has-text("Search")',
            ]:
                try:
                    submit_btn = await page.query_selector(sel)
                    if submit_btn and await submit_btn.is_visible():
                        break
                    submit_btn = None
                except Exception:
                    continue

            if not submit_btn:
                # Fallback: try clicking via JS
                clicked = await page.evaluate("""() => {
                    const btns = Array.from(document.querySelectorAll('input, button, a'));
                    const search = btns.find(el => {
                        const text = (el.value || el.textContent || '').toLowerCase();
                        return text.includes('search') && !text.includes('advanced') && !text.includes('clear');
                    });
                    if (search) { search.click(); return true; }
                    return false;
                }""")
                if not clicked:
                    logger.warning("Could not find search/submit button")
                    return False
            else:
                await submit_btn.click()

            # Wait for results to load
            await page.wait_for_load_state("networkidle", timeout=30000)
            await page.wait_for_timeout(3000)

            # Check if we landed on results page or if results appeared on same page
            current_url = page.url
            logger.info(f"After search submit, URL: {current_url}")

            return True

        except PlaywrightTimeout as e:
            logger.error(f"Timeout filling search form: {e}")
            return False
        except Exception as e:
            logger.error(f"Error filling search form: {e}")
            return False

    async def _try_select_option(
        self, page: Page, selectors: list[str], value_patterns: list[str]
    ) -> bool:
        """
        Try to select an option from a dropdown using multiple selectors and value patterns.
        Returns True if successful.
        """
        for sel in selectors:
            try:
                element = await page.query_selector(sel)
                if not element:
                    continue

                # Get all options
                options = await element.query_selector_all("option")
                for opt in options:
                    text = (await opt.inner_text()).strip()
                    value = await opt.get_attribute("value") or ""
                    for pattern in value_patterns:
                        if pattern.lower() in text.lower() or pattern.lower() in value.lower():
                            await element.select_option(value=value)
                            await page.wait_for_timeout(500)
                            logger.debug(f"Selected '{text}' in {sel}")
                            return True
            except Exception as e:
                logger.debug(f"Failed to use selector {sel}: {e}")
        return False

    async def _extract_results(self, page: Page, seen_ids: set[str]) -> list[RawScrapedEvent]:
        """
        Extract bid listings from the current search results page.

        BidSync results are typically displayed in a table with columns for:
        bid title/number, agency, posted date, due date, status, etc.
        """
        events = []

        # Strategy 1: Look for result rows in a table
        rows = await page.query_selector_all(
            'table.searchResultsTable tbody tr, '
            'table[id*="searchResult"] tbody tr, '
            'table[id*="result"] tbody tr, '
            '.search-results tr, '
            'table.list tbody tr'
        )

        if not rows:
            # Strategy 2: Try broader table row selection
            rows = await page.query_selector_all("table tbody tr")

        if not rows:
            # Strategy 3: Try div-based result cards
            rows = await page.query_selector_all(
                '.bid-result, .search-result-item, '
                '[class*="result-row"], [class*="bidRow"]'
            )

        if not rows:
            # Strategy 4: Use JS to find result elements
            result_data = await page.evaluate("""() => {
                const results = [];
                // Look for links to bid detail pages
                const links = document.querySelectorAll('a[href*="BidDetail"], a[href*="bidDetail"], a[href*="bidid"]');
                links.forEach(link => {
                    const row = link.closest('tr') || link.closest('div') || link.parentElement;
                    if (!row) return;
                    const text = row.innerText || '';
                    const href = link.href || '';
                    results.push({ text, href, linkText: link.innerText.trim() });
                });
                return results;
            }""")

            for item in result_data:
                event = self._parse_js_result(item, seen_ids)
                if event:
                    events.append(event)
            return events

        # Parse table rows
        for row in rows:
            try:
                event = await self._extract_table_row(page, row, seen_ids)
                if event:
                    events.append(event)
            except Exception as e:
                logger.debug(f"Failed to extract row: {e}")

        return events

    async def _extract_table_row(
        self, page: Page, row, seen_ids: set[str]
    ) -> RawScrapedEvent | None:
        """Extract a single bid from a results table row."""
        cells = await row.query_selector_all("td")
        if not cells or len(cells) < 2:
            return None

        cell_texts = []
        for cell in cells:
            text = (await cell.inner_text()).strip()
            cell_texts.append(text)

        # Find the title link (usually links to BidDetail page)
        title = ""
        detail_url = ""
        bid_id = ""

        title_link = await row.query_selector('a[href*="BidDetail"], a[href*="bidDetail"], a[href*="bidid"]')
        if not title_link:
            title_link = await row.query_selector("a")

        if title_link:
            title = (await title_link.inner_text()).strip()
            href = await title_link.get_attribute("href") or ""
            if href:
                if not href.startswith("http"):
                    detail_url = f"https://www.bidsync.com{href}"
                else:
                    detail_url = href
                # Extract bid ID from URL
                bid_id_match = re.search(r'bidid=(\d+)', href, re.IGNORECASE)
                if bid_id_match:
                    bid_id = bid_id_match.group(1)

        # Fallback: title from longest cell text
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
            m = re.search(
                r'\d{1,2}/\d{1,2}/\d{2,4}(?:\s+\d{1,2}:\d{2}(?:\s*[APap][Mm])?)?',
                text,
            )
            if m:
                dates.append(m.group(0))

        posted_date = dates[0] if dates else None
        due_date = dates[1] if len(dates) > 1 else (dates[0] if dates else None)

        # Extract agency/organization name (usually one of the cells)
        org_name = ""
        for text in cell_texts:
            # Skip dates, numbers, and the title
            if text == title:
                continue
            if re.match(r'^\d{1,2}/\d{1,2}/\d{2,4}', text):
                continue
            if re.match(r'^\$[\d,.]+$', text):
                continue
            if re.match(r'^\d+$', text):
                continue
            if len(text) > 5 and not text.isdigit():
                # Heuristic: agency name is a medium-length text that isn't a date or amount
                if not org_name or (len(text) > 10 and text != title):
                    org_name = text

        # Determine source_id and agency based on org name
        if org_name:
            source_id, agency_name = _match_agency(org_name)
        else:
            source_id = self.source_id
            agency_name = self._agency_name

        # Generate event ID
        if not bid_id:
            bid_id = re.sub(r'[^a-zA-Z0-9]', '_', title[:50])

        if bid_id in seen_ids:
            return None

        # Extract bid number/type from cells
        bid_number = ""
        bid_type = "Bid"
        for text in cell_texts:
            # Bid numbers are typically alphanumeric, 4+ chars, with dashes/dots
            if re.match(r'^[A-Z0-9][-A-Z0-9.]{3,}$', text.strip(), re.IGNORECASE):
                bid_number = text.strip()
            # Bid type keywords
            text_lower = text.lower()
            if any(kw in text_lower for kw in ["rfp", "rfq", "ifb", "rfb", "rfi"]):
                bid_type = text.strip()

        return RawScrapedEvent(
            source_id=source_id,
            source_event_id=bid_id,
            source_url=detail_url or page.url,
            title=title,
            issuing_agency=agency_name,
            posted_date=posted_date,
            due_date=due_date,
            procurement_type=bid_type,
            raw_metadata={
                "bid_number": bid_number,
                "org_name_raw": org_name,
            },
        )

    def _parse_js_result(self, item: dict, seen_ids: set[str]) -> RawScrapedEvent | None:
        """Parse a result extracted via JavaScript evaluation."""
        text = item.get("text", "")
        href = item.get("href", "")
        link_text = item.get("linkText", "")

        title = link_text or ""
        if not title:
            return None

        # Extract bid ID from URL
        bid_id = ""
        bid_id_match = re.search(r'bidid=(\d+)', href, re.IGNORECASE)
        if bid_id_match:
            bid_id = bid_id_match.group(1)
        else:
            bid_id = re.sub(r'[^a-zA-Z0-9]', '_', title[:50])

        if bid_id in seen_ids:
            return None

        detail_url = href if href.startswith("http") else f"https://www.bidsync.com{href}"

        # Extract dates from the row text
        dates = re.findall(
            r'\d{1,2}/\d{1,2}/\d{2,4}(?:\s+\d{1,2}:\d{2}(?:\s*[APap][Mm])?)?',
            text,
        )
        posted_date = dates[0] if dates else None
        due_date = dates[1] if len(dates) > 1 else None

        # Try to extract agency name from text (it's usually on a separate line or cell)
        lines = [l.strip() for l in text.split('\n') if l.strip()]
        org_name = ""
        for line in lines:
            if line == title:
                continue
            if re.match(r'^\d{1,2}/\d{1,2}/\d{2,4}', line):
                continue
            if len(line) > 5:
                org_name = line
                break

        if org_name:
            source_id, agency_name = _match_agency(org_name)
        else:
            source_id = self.source_id
            agency_name = self._agency_name

        return RawScrapedEvent(
            source_id=source_id,
            source_event_id=bid_id,
            source_url=detail_url,
            title=title,
            issuing_agency=agency_name,
            posted_date=posted_date,
            due_date=due_date,
            procurement_type="Bid",
            raw_metadata={"org_name_raw": org_name},
        )

    async def _go_to_next_page(self, page: Page) -> bool:
        """
        Navigate to the next page of search results.
        Returns True if pagination succeeded, False if on the last page.
        """
        # Strategy 1: Look for a "Next" button/link
        for sel in [
            'a[aria-label="Next"]',
            'a:has-text("Next")',
            'a:has-text("next")',
            'a:has-text(">")',
            'input[value="Next"]',
            'button:has-text("Next")',
            '.pagination .next a',
            '.pagination-next a',
            'a[class*="next"]',
            'li.next a',
        ]:
            try:
                btn = await page.query_selector(sel)
                if btn and await btn.is_visible():
                    disabled = await btn.get_attribute("disabled")
                    cls = await btn.get_attribute("class") or ""
                    if disabled or "disabled" in cls:
                        return False
                    await btn.click()
                    await page.wait_for_load_state("networkidle", timeout=30000)
                    await page.wait_for_timeout(2000)
                    return True
            except PlaywrightTimeout:
                return False
            except Exception:
                continue

        # Strategy 2: Use JS to find and click a Next link/button
        clicked = await page.evaluate("""() => {
            const els = Array.from(document.querySelectorAll('a, button, input'));
            const next = els.find(el => {
                const text = (el.value || el.textContent || el.title || '').trim().toLowerCase();
                const cls = (el.className || '').toLowerCase();
                return (text === 'next' || text === '>' || text === '>>' || text === '\u203a' || cls.includes('next'))
                    && !el.disabled && !cls.includes('disabled');
            });
            if (next) { next.click(); return true; }
            return false;
        }""")

        if clicked:
            try:
                await page.wait_for_load_state("networkidle", timeout=30000)
                await page.wait_for_timeout(2000)
                return True
            except PlaywrightTimeout:
                return False

        return False

    async def scrape_bid_detail(self, page: Page, bid_id: str) -> dict:
        """
        Optionally fetch full details from a bid detail page.

        Returns a dict with description, contact info, attachments, etc.
        This is called separately from the main scrape loop for enrichment.
        """
        detail_url = BIDSYNC_BID_DETAIL.format(bid_id=bid_id)
        details = {}

        try:
            self.throttle()
            await page.goto(detail_url, wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(2000)

            # Extract description
            desc_el = await page.query_selector(
                '.bid-description, [id*="description"], '
                '.detail-description, [class*="description"]'
            )
            if desc_el:
                details["description"] = (await desc_el.inner_text()).strip()

            # Extract contact info
            contact_el = await page.query_selector(
                '.contact-info, [id*="contact"], '
                '[class*="contact"], .buyer-info'
            )
            if contact_el:
                contact_text = (await contact_el.inner_text()).strip()
                details["contact_text"] = contact_text
                # Parse contact info
                email_match = re.search(r'[\w.+-]+@[\w.-]+\.\w+', contact_text)
                phone_match = re.search(r'[\(]?\d{3}[\).\-\s]?\d{3}[.\-\s]?\d{4}', contact_text)
                details["contact"] = ContactInfo(
                    email=email_match.group(0) if email_match else None,
                    phone=phone_match.group(0) if phone_match else None,
                )

            # Extract attachment links
            attachment_links = await page.query_selector_all(
                'a[href*="attachment"], a[href*="document"], '
                'a[href*="download"], a[href*=".pdf"]'
            )
            details["attachment_urls"] = []
            for link in attachment_links:
                href = await link.get_attribute("href")
                if href:
                    if not href.startswith("http"):
                        href = f"https://www.bidsync.com{href}"
                    details["attachment_urls"].append(href)

        except Exception as e:
            logger.debug(f"Failed to fetch bid detail {bid_id}: {e}")

        return details


# ---------------------------------------------------------------------------
# Helper: generate SiteConfig entries for all known BidSync agencies
# ---------------------------------------------------------------------------

def get_bidsync_site_configs() -> dict[str, SiteConfig]:
    """
    Generate SiteConfig entries for BidSync scraping.

    Returns a single "bidsync_all_ca" config that searches all California
    bids at once, plus individual configs per agency for targeted scraping.
    """
    configs = {}

    # Master config: searches all CA bids in one pass
    configs["bidsync_all_ca"] = SiteConfig(
        site_id="bidsync_all_ca",
        name="BidSync - All California",
        url=BIDSYNC_ADVANCED_SEARCH,
        scraper_type="structured",
        min_request_interval_ms=3000,
        config={
            "mode": "all_ca",
            "name": "BidSync - All California",
        },
    )

    # Individual agency configs (can be used for targeted single-agency scraping)
    for site_id, agency in BIDSYNC_AGENCIES.items():
        configs[site_id] = SiteConfig(
            site_id=site_id,
            name=agency["name"],
            url=BIDSYNC_ADVANCED_SEARCH,
            scraper_type="structured",
            min_request_interval_ms=3000,
            config={
                "org_id": agency["org_id"],
                "name": agency["name"],
                "mode": "single",
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
    # Use the all-CA config for testing
    config = configs["bidsync_all_ca"]

    scraper = BidSyncScraper(config)
    events = await scraper.run()

    print(f"\nScraped {len(events)} events from {config.name}")
    for e in events[:10]:
        print(f"  [{e.source_id}] {e.title[:60]}")
        print(f"    Agency: {e.issuing_agency}")
        print(f"    Due: {e.due_date}")
        print(f"    URL: {e.source_url}")


if __name__ == "__main__":
    asyncio.run(main())
