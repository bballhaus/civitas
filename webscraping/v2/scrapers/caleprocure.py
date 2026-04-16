"""
Cal eProcure scraper — migrated from Selenium to Playwright.

Scrapes California's state procurement portal at caleprocure.ca.gov.
Extracts event URLs from the search page, then scrapes event detail pages
in parallel batches for speed.

This is a "structured" scraper (Tier 2) with hardcoded selectors for the
known page layout. If selectors break, the agentic scraper can take over.
"""

from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

from playwright.async_api import async_playwright, Page, BrowserContext

from webscraping.v2.models import RawScrapedEvent, ContactInfo, SiteConfig
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)

SEARCH_URL = "https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx"
MAX_EVENTS = 1000
# How many event pages to scrape concurrently within a batch
CONCURRENCY = 5


class CalEprocureScraper(BaseScraper):
    """Playwright-based scraper for Cal eProcure."""

    def __init__(
        self,
        site_config: SiteConfig | None = None,
        batch_offset: int = 0,
        batch_size: int | None = None,
    ):
        if site_config is None:
            site_config = SiteConfig(
                site_id="caleprocure",
                name="Cal eProcure",
                url=SEARCH_URL,
                scraper_type="structured",
                min_request_interval_ms=2000,
            )
        super().__init__(site_config)
        self.batch_offset = batch_offset
        self.batch_size = batch_size  # None = scrape all
        self.total_available = 0  # Set after loading search page

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        """Scrape all events from Cal eProcure search page."""
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
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                locale="en-US",
                timezone_id="America/Los_Angeles",
            )
            await context.add_init_script(
                'Object.defineProperty(navigator, "webdriver", {get: () => undefined});'
            )

            try:
                # Step 1: Load search page and discover event URLs
                # _get_event_urls already respects batch_offset/batch_size
                # when clicking rows, so it returns only the URLs we need.
                batch_urls = await self._get_event_urls(context)
                logger.info(f"Scraping {len(batch_urls)} events (total available: {self.total_available})")

                # Step 2: Scrape events in parallel sub-batches
                scraped = 0
                for sub_start in range(0, len(batch_urls), CONCURRENCY):
                    sub_end = min(sub_start + CONCURRENCY, len(batch_urls))
                    sub_urls = batch_urls[sub_start:sub_end]

                    tasks = [
                        self._scrape_event_by_url(
                            context, url, self.batch_offset + sub_start + i, self.total_available
                        )
                        for i, url in enumerate(sub_urls)
                    ]
                    results = await asyncio.gather(*tasks, return_exceptions=True)

                    for result in results:
                        if isinstance(result, Exception):
                            logger.error(f"Batch error: {result}")
                        elif result and result.title:
                            scraped += 1
                            yield result

                    self.throttle()

                logger.info(f"Scraped {scraped}/{len(batch_urls)} events in this batch")

            finally:
                await browser.close()

    async def _get_event_urls(self, context: BrowserContext) -> list[str]:
        """Load the search page and extract all event detail URLs."""
        page = await context.new_page()
        try:
            await page.goto(SEARCH_URL, wait_until="networkidle", timeout=60000)
            await page.wait_for_timeout(5000)

            # Extract event IDs and construct URLs directly
            # Each row has a click handler that opens /event/{dept_id}/{event_id}
            # We can extract these from the row data attributes
            urls = await page.evaluate("""() => {
                const rows = document.querySelectorAll('[data-if-label^="tblBodyTr"]');
                const urls = [];
                for (const row of rows) {
                    if (row.classList.contains('if-hide') || row.offsetParent === null) continue;

                    // Get event ID from the cell
                    const idCell = row.querySelector('[data-if-label="tdEventId"]');
                    if (!idCell) continue;

                    // Look for onclick or href that reveals the event URL
                    const links = row.querySelectorAll('a[href*="event"]');
                    if (links.length > 0) {
                        urls.push(links[0].href);
                        continue;
                    }

                    // Extract the event ID text — we'll need to click to get URLs
                    const eventId = idCell.textContent.trim();
                    if (eventId) {
                        urls.push(eventId);
                    }
                }
                return urls;
            }""")

            self.total_available = len(urls)

            # If we got event IDs instead of URLs, we need to click to discover URLs
            if urls and not urls[0].startswith("http"):
                logger.info(f"Got {len(urls)} event IDs, discovering URL pattern via click...")
                event_urls = await self._discover_urls_by_clicking(context, page, urls)
                return event_urls

            return urls[:MAX_EVENTS]
        finally:
            await page.close()

    async def _discover_urls_by_clicking(
        self, context: BrowserContext, search_page: Page, event_ids: list[str]
    ) -> list[str]:
        """Click each event row to discover its URL (via the loading.html redirect)."""
        urls = []

        all_rows = await search_page.query_selector_all('[data-if-label^="tblBodyTr"]')
        visible_rows = []
        for row in all_rows:
            cls = await row.get_attribute("class") or ""
            if "if-hide" not in cls and await row.is_visible():
                visible_rows.append(row)

        # Click first row to discover URL pattern
        if visible_rows:
            row = visible_rows[0]
            cell = await row.query_selector('[data-if-label="tdEventId"]')
            if cell:
                async with context.expect_page(timeout=15000) as new_page_info:
                    await cell.click()
                event_page = await new_page_info.value
                try:
                    await event_page.wait_for_url("**/event/**", timeout=30000)
                    # URL pattern: https://caleprocure.ca.gov/event/{dept}/{id}
                    url = event_page.url
                    logger.info(f"Discovered URL pattern: {url}")

                    # The URL follows pattern: base/event/{dept_code}/{event_number}
                    # We can construct URLs for all events using their IDs
                    # But Cal eProcure URLs require dept code which isn't in the search table
                    # So we need to click each one individually
                finally:
                    await event_page.close()

        # Click each row to discover its URL. Only click the rows we need
        # for this batch (respects batch_offset and batch_size from Lambda).
        start = self.batch_offset
        end = min(
            start + (self.batch_size or len(visible_rows)),
            len(visible_rows),
            MAX_EVENTS,
        )
        batch_rows = list(range(start, end))
        logger.info(f"Clicking events {start+1}-{end} of {len(visible_rows)} to get URLs...")
        for i in batch_rows:
            try:
                # Need to reload search page for each click (Cal eProcure quirk)
                if i > 0:
                    await search_page.goto(SEARCH_URL, wait_until="networkidle", timeout=60000)
                    await search_page.wait_for_timeout(3000)
                    all_rows = await search_page.query_selector_all('[data-if-label^="tblBodyTr"]')
                    visible_rows = [
                        r for r in all_rows
                        if "if-hide" not in (await r.get_attribute("class") or "")
                        and await r.is_visible()
                    ]
                    if i >= len(visible_rows):
                        break
                    row = visible_rows[i]

                cell = await row.query_selector('[data-if-label="tdEventId"]')
                if not cell:
                    continue

                async with context.expect_page(timeout=15000) as new_page_info:
                    await cell.click()
                event_page = await new_page_info.value
                try:
                    await event_page.wait_for_url("**/event/**", timeout=30000)
                    urls.append(event_page.url)
                finally:
                    await event_page.close()

            except Exception as e:
                logger.debug(f"Could not get URL for event {i}: {e}")

        return urls

    async def _scrape_event_by_url(
        self,
        context: BrowserContext,
        url: str,
        index: int,
        total: int,
    ) -> RawScrapedEvent | None:
        """Scrape a single event by navigating directly to its URL."""
        page = await context.new_page()
        try:
            # If it's an event URL, navigate directly
            if url.startswith("http"):
                await page.goto(url, wait_until="networkidle", timeout=30000)
                await page.wait_for_timeout(2000)
            else:
                # It's an event ID — we'd need to construct the URL
                # This shouldn't happen with the current flow
                return None

            event_data = await self._extract_event_data(page)
            if event_data.title:
                logger.info(f"[{index + 1}/{total}] {event_data.title[:60]}")

            # Download attachments inline (session-bound URLs expire after browser closes)
            attachments = await self._download_attachments(page)
            event_data.attachment_urls = [a["url"] for a in attachments if a.get("url")]
            if attachments:
                event_data.raw_metadata["attachment_texts"] = {
                    a["filename"]: a["text"] for a in attachments if a.get("text")
                }

            return event_data

        except Exception as e:
            logger.error(f"Error on event {index + 1}/{total}: {e}")
            return None
        finally:
            await page.close()

    async def _extract_event_data(self, page: Page) -> RawScrapedEvent:
        """Extract event metadata from an event detail page."""
        url = page.url
        parts = url.split("/")
        event_id = f"{parts[-2]}/{parts[-1]}" if len(parts) >= 4 else "unknown"

        async def get_text(selector: str, placeholder: str = "") -> str:
            try:
                elem = await page.wait_for_selector(selector, timeout=5000)
                if elem:
                    text = (await elem.inner_text()).strip()
                    if text and text != placeholder:
                        return text
            except Exception:
                pass
            return ""

        title = await get_text('[data-if-label="eventName"]', "[Event Title]")
        description = await get_text('[data-if-label="descriptiondetails"]', "[Detail Description]")
        contact_name = await get_text('[data-if-label="contactName"]', "[Contact Name]")
        contact_phone = await get_text('[data-if-label="phoneText"]', "[Phone Number]")
        department = await get_text('[data-if-label="dept"]')
        start_date = await get_text('[data-if-label="eventStartDate"]')
        end_date = await get_text('[data-if-label="eventEndDate"]')

        # Email has a fallback selector
        contact_email = await get_text('[data-if-label="emailAnchor"]', "[EmailAddress]")
        if not contact_email:
            contact_email = await get_text("#RESP_INQ_DL0_WK_EMAILID")

        # Format
        format1 = await get_text('[data-if-label="format1"]')
        format2 = await get_text('[data-if-label="format2"]')
        procurement_type = f"{format1} / {format2}".strip(" /") if format1 or format2 else ""

        return RawScrapedEvent(
            source_id="caleprocure",
            source_event_id=event_id,
            source_url=url,
            title=title,
            description=description,
            issuing_agency=department,
            posted_date=start_date,
            due_date=end_date,
            contact=ContactInfo(
                name=contact_name or None,
                email=contact_email or None,
                phone=contact_phone or None,
            ),
            procurement_type=procurement_type,
            raw_metadata={
                "format": procurement_type,
                "start_date": start_date,
                "end_date": end_date,
            },
        )

    async def _download_attachments(self, page: Page) -> list[dict]:
        """Click 'View Event Package', download PDFs via Playwright, and extract text.

        Cal eProcure download URLs are session-bound tokens that expire when the
        browser closes, so we must download within the same Playwright session.
        Returns a list of dicts: [{"filename": str, "url": str, "text": str}, ...]
        """
        results = []
        try:
            view_pkg = await page.wait_for_selector(
                '[data-if-label="viewPackage"]', timeout=5000
            )
            if not view_pkg:
                return results
            await view_pkg.click()
            await page.wait_for_timeout(4000)

            # Wait for attachments table
            await page.wait_for_selector(
                '[data-if-label^="ViewAttachmentsTableRow"]', timeout=10000
            )

            buttons = await page.query_selector_all(
                'button[data-if-label^="ViewAttachmentsView"]'
            )

            for i in range(len(buttons)):
                try:
                    # Re-query buttons (DOM may change after modal interactions)
                    buttons = await page.query_selector_all(
                        'button[data-if-label^="ViewAttachmentsView"]'
                    )
                    if i >= len(buttons):
                        break

                    btn = buttons[i]
                    await btn.scroll_into_view_if_needed()
                    await page.wait_for_timeout(500)
                    await btn.click()

                    # Wait for attachment modal
                    await page.wait_for_selector("#attachmentBox", state="visible", timeout=10000)
                    await page.wait_for_timeout(2000)

                    download_btn = await page.wait_for_selector("#downloadButton", timeout=5000)
                    if not download_btn:
                        continue

                    pdf_url = await download_btn.get_attribute("href") or ""
                    filename = pdf_url.split("/")[-1].split("?")[0] if pdf_url else f"attachment_{i}.pdf"

                    # Skip non-PDF files and drawings/maps
                    from webscraping.v2.pipeline.enrich import classify_pdf
                    if classify_pdf(filename) == "skip":
                        logger.debug(f"  Skipping {filename} (classified as skip)")
                    elif pdf_url:
                        # Download via Playwright (uses browser session cookies)
                        try:
                            async with page.expect_download(timeout=30000) as download_info:
                                await download_btn.click()
                            download = await download_info.value
                            tmp_path = await download.path()

                            if tmp_path:
                                # Extract text with PyMuPDF
                                from webscraping.v2.pipeline.enrich import extract_text_from_pdf
                                text = extract_text_from_pdf(str(tmp_path))
                                if text:
                                    logger.info(f"  PDF: {filename} ({len(text)} chars)")
                                    results.append({
                                        "filename": filename,
                                        "url": pdf_url,
                                        "text": text,
                                    })
                                else:
                                    logger.debug(f"  No text from {filename}")
                                    results.append({"filename": filename, "url": pdf_url, "text": ""})
                        except Exception as e:
                            logger.warning(f"  Download failed for {filename}: {e}")
                            results.append({"filename": filename, "url": pdf_url, "text": ""})

                    # Close modal
                    close_btn = await page.query_selector(
                        "#attachmentWrapperModal .btn-outline-primary"
                    )
                    if close_btn:
                        await close_btn.click()
                    await page.wait_for_timeout(2000)

                except Exception as e:
                    logger.warning(f"Error on attachment #{i + 1}: {e}")
                    try:
                        close_btn = await page.query_selector(
                            "#attachmentWrapperModal .btn-outline-primary"
                        )
                        if close_btn:
                            await close_btn.click()
                    except Exception:
                        pass
                    await page.wait_for_timeout(2000)

        except Exception as e:
            logger.debug(f"No attachments or error: {e}")

        return results


# ---------------------------------------------------------------------------
# Standalone runner
# ---------------------------------------------------------------------------

async def main():
    """Run the Cal eProcure scraper standalone."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    scraper = CalEprocureScraper()
    events = await scraper.run()

    print(f"\nScraped {len(events)} events")
    for e in events[:5]:
        print(f"  - {e.title[:60]} ({e.source_event_id})")
        print(f"    Attachments: {len(e.attachment_urls)}")


if __name__ == "__main__":
    asyncio.run(main())
