"""
Cal eProcure scraper — migrated from Selenium to Playwright.

Scrapes California's state procurement portal at caleprocure.ca.gov.
Navigates the event search page, clicks into individual events, extracts
metadata, and downloads attachment PDFs.

This is a "structured" scraper (Tier 2) with hardcoded selectors for the
known page layout. If selectors break, the agentic scraper can take over.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from typing import AsyncIterator

from playwright.async_api import async_playwright, Page, BrowserContext

from webscraping.v2.models import RawScrapedEvent, ContactInfo, SiteConfig
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)

SEARCH_URL = "https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx"
MAX_EVENTS = 1000


class CalEprocureScraper(BaseScraper):
    """Playwright-based scraper for Cal eProcure."""

    def __init__(self, site_config: SiteConfig | None = None):
        if site_config is None:
            site_config = SiteConfig(
                site_id="caleprocure",
                name="Cal eProcure",
                url=SEARCH_URL,
                scraper_type="structured",
                min_request_interval_ms=2000,
            )
        super().__init__(site_config)

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        """Scrape all events from Cal eProcure search page."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
            )
            page = await context.new_page()

            try:
                logger.info("Loading search page...")
                await page.goto(SEARCH_URL, wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(5000)

                # Find visible event rows
                all_rows = await page.query_selector_all('[data-if-label^="tblBodyTr"]')
                visible_rows = []
                for row in all_rows:
                    cls = await row.get_attribute("class") or ""
                    if "if-hide" not in cls and await row.is_visible():
                        visible_rows.append(row)

                total = min(len(visible_rows), MAX_EVENTS)
                logger.info(f"Found {len(visible_rows)} events, scraping first {total}")

                for i in range(total):
                    try:
                        event = await self._scrape_event(context, page, i, total)
                        if event and event.title:
                            yield event
                    except Exception as e:
                        logger.error(f"Error on event {i + 1}/{total}: {e}")
                        continue

            finally:
                await browser.close()

    async def _scrape_event(
        self,
        context: BrowserContext,
        search_page: Page,
        index: int,
        total: int,
    ) -> RawScrapedEvent | None:
        """Scrape a single event by clicking its row on the search page."""
        self.throttle()

        # Reload search page to reset state
        await search_page.goto(SEARCH_URL, wait_until="networkidle", timeout=60000)
        await search_page.wait_for_timeout(3000)

        # Re-find visible rows
        all_rows = await search_page.query_selector_all('[data-if-label^="tblBodyTr"]')
        visible_rows = []
        for row in all_rows:
            cls = await row.get_attribute("class") or ""
            if "if-hide" not in cls and await row.is_visible():
                visible_rows.append(row)

        if index >= len(visible_rows):
            return None

        row = visible_rows[index]

        # Click the event ID cell to open in new tab
        event_id_cell = await row.query_selector('[data-if-label="tdEventId"]')
        if not event_id_cell:
            return None

        # Open in new page via popup
        async with context.expect_page() as new_page_info:
            await event_id_cell.click()
        event_page = await new_page_info.value
        await event_page.wait_for_load_state("networkidle", timeout=30000)

        try:
            event_data = await self._extract_event_data(event_page)
            logger.info(f"[{index + 1}/{total}] {event_data.title[:60]}")

            # Download attachments
            attachment_urls = await self._get_attachment_urls(event_page)
            event_data.attachment_urls = attachment_urls

            return event_data
        finally:
            await event_page.close()

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

    async def _get_attachment_urls(self, page: Page) -> list[str]:
        """Click 'View Event Package' and extract attachment download URLs."""
        urls = []
        try:
            view_pkg = await page.wait_for_selector(
                '[data-if-label="viewPackage"]', timeout=5000
            )
            if not view_pkg:
                return urls
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
                    if download_btn:
                        pdf_url = await download_btn.get_attribute("href")
                        if pdf_url:
                            urls.append(pdf_url)

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

        return urls


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
