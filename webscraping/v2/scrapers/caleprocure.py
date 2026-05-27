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
from webscraping.v2.scrapers.caleprocure_dept_codes import (
    AGENCY_TO_BUS_UNIT,
    normalize_agency,
)
from webscraping.v2.utils import make_event_id

logger = logging.getLogger(__name__)

SEARCH_URL = "https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx"
EVENT_URL_TEMPLATE = "https://caleprocure.ca.gov/event/{bus_unit}/{auc_id}"
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
        """Load the search page and construct event detail URLs.

        URL shape is `/event/{BUSINESS_UNIT}/{AUC_ID}`. AUC_ID is exposed in
        the row's `tdEventId` cell. BUSINESS_UNIT is *not* in the DOM — but
        the agency display name (in `tdDepName`) maps 1:1 to BUSINESS_UNIT
        across CalEP's stable PeopleSoft enumeration, so we look it up in
        `AGENCY_TO_BUS_UNIT` instead of clicking through PeopleSoft's
        redirect. Click-based discovery was ~97% flaky because the popup
        intermittently navigates to the underlying `event-details.aspx`
        form (which then bounces to `/pages/`) instead of the friendly
        `/event/...` rewrite.

        Falls back to a single click for any agency missing from the map,
        and logs a WARNING naming the agency so we can extend the dict.
        """
        page = await context.new_page()
        try:
            # Don't gate on networkidle — CalEP's analytics + GTM never
            # settle. Wait specifically for a data row to be attached
            # (visibility check fails under headless because PSoft's
            # data-binding pass marks rows attached before they're visually
            # painted; `state="attached"` is the real readiness signal).
            await page.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=60000)
            try:
                await page.wait_for_selector(
                    "tr[id^='trRESP_INQA_HD_VW']", state="attached", timeout=30000
                )
                # Give the PSoft data-binding pass a moment to populate
                # cell text from the underlying model.
                await page.wait_for_timeout(2000)
            except Exception:
                logger.warning(
                    "Search-page rows did not appear within 30s — "
                    "table may be empty or page hit a soft block."
                )
                return []

            # Extract (auc_id, agency) for every row in one round-trip.
            # Hidden rows (the unbound template clones) are filtered by
            # `if-hide` class; the populated rows have id prefix
            # `trRESP_INQA_HD_VW`.
            rows_data = await page.evaluate("""() => {
                const rows = document.querySelectorAll("tr[id^='trRESP_INQA_HD_VW']");
                const out = [];
                for (const row of rows) {
                    if (row.classList.contains('if-hide')) continue;
                    const idCell = row.querySelector('[data-if-label="tdEventId"]');
                    const depCell = row.querySelector('[data-if-label="tdDepName"]');
                    if (!idCell || !depCell) continue;
                    const aucId = (idCell.textContent || '').trim();
                    const agency = (depCell.textContent || '').trim();
                    if (aucId) out.push({aucId, agency});
                }
                return out;
            }""")

            self.total_available = len(rows_data)
            logger.info(
                f"Discovered {len(rows_data)} events on search page; "
                f"agency map has {len(AGENCY_TO_BUS_UNIT)} entries."
            )

            # Honor batch_offset / batch_size: the Lambda chains batches
            # across invocations, so this scraper instance only handles
            # its assigned slice.
            start = self.batch_offset
            end = min(
                start + (self.batch_size or len(rows_data)),
                len(rows_data),
                MAX_EVENTS,
            )
            batch = rows_data[start:end]

            # Resolve URLs from the map; collect any unknown agencies for
            # a per-row click fallback.
            urls: list[str] = []
            unknown_indices: list[int] = []
            for i, item in enumerate(batch):
                agency = normalize_agency(item["agency"])
                bus_unit = AGENCY_TO_BUS_UNIT.get(agency)
                if bus_unit:
                    urls.append(
                        EVENT_URL_TEMPLATE.format(
                            bus_unit=bus_unit, auc_id=item["aucId"]
                        )
                    )
                else:
                    unknown_indices.append(i)

            if unknown_indices:
                unknown_agencies = sorted({batch[i]["agency"] for i in unknown_indices})
                logger.warning(
                    f"{len(unknown_indices)} rows have agencies not in "
                    f"AGENCY_TO_BUS_UNIT (will fall back to click): "
                    f"{unknown_agencies}"
                )
                fallback_urls = await self._click_discover_for_unknowns(
                    context, page, batch, unknown_indices
                )
                urls.extend(fallback_urls)

            return urls
        finally:
            await page.close()

    async def _click_discover_for_unknowns(
        self,
        context: BrowserContext,
        search_page: Page,
        batch: list[dict],
        unknown_indices: list[int],
    ) -> list[str]:
        """Per-row click fallback for agencies missing from AGENCY_TO_BUS_UNIT.

        Same flaky popup-redirect flow as the old code path, but now only
        runs for new agencies — typically zero rows. Each successful click
        also extends AGENCY_TO_BUS_UNIT in-memory so a later row from the
        same new agency hits the cache instead of clicking again.

        Capped at MAX_FALLBACK_CLICKS per invocation: each click costs
        ~30s on the slow path, so an avalanche of unknown rows could blow
        the Lambda timeout. Anything past the cap is skipped and surfaces
        through the WARNING emitted by the caller — we'd rather lose a
        few rows this run than the whole batch.
        """
        MAX_FALLBACK_CLICKS = 3
        urls: list[str] = []
        # Group unknowns by agency so we only burn one click per new
        # agency, then resolve the rest from the freshly-cached BUS_UNIT.
        by_agency: dict[str, list[int]] = {}
        for i in unknown_indices:
            agency = normalize_agency(batch[i]["agency"])
            by_agency.setdefault(agency, []).append(i)

        clicks_done = 0
        for agency, indices in by_agency.items():
            if clicks_done >= MAX_FALLBACK_CLICKS:
                logger.warning(
                    f"Fallback click cap ({MAX_FALLBACK_CLICKS}) hit; "
                    f"skipping {len(by_agency) - clicks_done} more new agencies "
                    f"this batch."
                )
                break
            probe_idx = indices[0]
            probe_auc_id = batch[probe_idx]["aucId"]
            bus_unit = await self._discover_bus_unit_via_click(
                context, search_page, probe_auc_id, agency
            )
            clicks_done += 1
            if bus_unit is None:
                continue
            AGENCY_TO_BUS_UNIT[agency] = bus_unit
            for i in indices:
                urls.append(
                    EVENT_URL_TEMPLATE.format(
                        bus_unit=bus_unit, auc_id=batch[i]["aucId"]
                    )
                )
        return urls

    async def _discover_bus_unit_via_click(
        self,
        context: BrowserContext,
        search_page: Page,
        auc_id: str,
        agency: str,
    ) -> str | None:
        """Click the row for `auc_id` to discover its BUSINESS_UNIT.

        Uses dispatch_event('click') because PSoft data rows are flagged
        not-visible by Playwright in headless (the InFlight framework
        paints them at z-index/opacity that fails Playwright's visibility
        heuristic even though they're functionally clickable). The PSoft
        click handler is bound via addEventListener, so dispatch_event
        triggers the same code path as a real click without the
        visibility gate.
        """
        try:
            cell = search_page.locator(
                f"tr[id^='trRESP_INQA_HD_VW']:not(.if-hide) "
                f"td[data-if-label='tdEventId']:has-text('{auc_id}')"
            ).first
            async with context.expect_page(timeout=15000) as new_page_info:
                await cell.dispatch_event("click")
            event_page = await new_page_info.value
            try:
                await event_page.wait_for_url("**/event/**", timeout=20000)
                discovered = event_page.url
                # URL is /event/{bus_unit}/{auc_id}; pull the second-to-last
                # path segment regardless of trailing slashes.
                parts = discovered.rstrip("/").split("/")
                if len(parts) >= 2 and parts[-2].isdigit():
                    bus_unit = parts[-2]
                    logger.info(
                        f"Click fallback resolved new agency {agency!r} "
                        f"-> BUS_UNIT {bus_unit}. Add to AGENCY_TO_BUS_UNIT."
                    )
                    return bus_unit
                logger.warning(
                    f"Click fallback for {agency!r} got non-standard URL: "
                    f"{discovered}"
                )
                return None
            finally:
                await event_page.close()
        except Exception as e:
            logger.warning(
                f"Click fallback failed for {agency!r} AUC_ID {auc_id}: "
                f"{type(e).__name__}: {e}"
            )
            return None

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
                # The previous strategy was page.goto(wait_until="networkidle",
                # timeout=30000), which timed out on 40-67% of events because
                # the Cal eProcure SPA loads analytics + tracking pixels that
                # keep the network active well past page hydration. We now use
                # domcontentloaded (returns once the DOM tree is built) and
                # then wait for a specific data-if-label element that only
                # exists after the SPA's data-binding pass runs — that's the
                # real readiness signal. networkidle is the wrong gate for
                # ad-heavy SPAs.
                try:
                    await page.goto(
                        url, wait_until="domcontentloaded", timeout=45000
                    )
                except Exception as e:
                    logger.warning(
                        f"  nav: goto failed ({type(e).__name__}) {url}"
                    )
                    return None
                # Wait for the SPA's data-binding to hydrate. eventName
                # is bound from #AUC_HDR_AUC_NAME and is present on every
                # event detail page. 20s is generous; if it's not visible
                # by then the page is broken or the event is gone.
                try:
                    await page.wait_for_selector(
                        '[data-if-label="eventName"]',
                        state="attached",
                        timeout=20000,
                    )
                except Exception:
                    logger.info(
                        f"  nav: hydration marker missing after goto {url}"
                    )
                    # Don't return — _extract_event_data has its own per-field
                    # waits and may still get partial data. _download_attachments
                    # will log its own state.
                await page.wait_for_timeout(1000)
            else:
                # It's an event ID — we'd need to construct the URL
                # This shouldn't happen with the current flow
                return None

            event_data = await self._extract_event_data(page)
            if event_data.title:
                logger.info(f"[{index + 1}/{total}] {event_data.title[:60]}")

            # Download attachments inline (session-bound URLs expire after browser closes).
            # _download_attachments stashes mirrors directly onto event_data.raw_metadata
            # as each PDF uploads — so a later exception can't orphan an already-mirrored PDF.
            attachments = await self._download_attachments(page, event_data)
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

    async def _download_attachments(
        self, page: Page, event: RawScrapedEvent
    ) -> list[dict]:
        """Click 'View Event Package', fetch PDFs via session cookies, extract text.

        Cal eProcure download URLs are session-bound tokens that expire when the
        browser closes. Earlier we triggered downloads by clicking the download
        button, which hit Playwright actionability timeouts (modal overlay
        intercepted the click). Now we read the href off `#downloadButton` and
        fetch it directly through the browser context (same cookies → same
        session) — no click required.
        Returns a list of dicts: [{"filename": str, "url": str, "text": str, "s3_key": str|None}, ...]

        Side effect: appends to `event.raw_metadata['mirrored_attachments']`
        the moment each PDF lands in S3 — *before* moving on to the next
        attachment — so a later per-attachment timeout or caller-level
        exception can't orphan an already-mirrored PDF.

        Logs the specific failure step at INFO level (was previously a single
        debug-level catch that obscured why ~90% of events end up with empty
        attachment_urls). Failure modes seen in the wild:
          - viewPackage selector never appears (page is an award detail, or
            event isn't a Sell Event in the expected layout).
          - viewPackage appears but the attachments table never renders (the
            package is empty, or the modal hydration was slower than the 10s
            wait).
          - Individual row click fails (overlay intercept).
        """
        from webscraping.v2.pipeline.enrich import classify_pdf, extract_text_from_pdf

        results = []
        url = page.url
        event_id = make_event_id(event.source_id, event.source_event_id)
        # Mirror records live on event.raw_metadata so they survive any
        # exception in the loop below. setdefault → append == idempotent
        # under per-attachment retries.
        mirror_sink = event.raw_metadata.setdefault("mirrored_attachments", [])

        # Diagnostic helper: detect alternative buttons that explain why
        # viewPackage is absent. Doesn't block — best-effort.
        async def _has(selector: str) -> bool:
            try:
                el = await page.query_selector(selector)
                return el is not None
            except Exception:
                return False

        try:
            try:
                view_pkg = await page.wait_for_selector(
                    '[data-if-label="viewPackage"]', timeout=12000, state="visible"
                )
            except Exception:
                view_pkg = None
            if not view_pkg:
                # Diagnose: is this an award-state event? An awarded/closed
                # listing renders viewAwardDetails instead of viewPackage and
                # has no download path through this code path.
                if await _has('[data-if-label="viewAwardDetails"]'):
                    logger.info(f"  attach: skip (award-state event) {url}")
                elif await _has('[data-if-label="subscribe"]'):
                    # Page hydrated (subscribe button is on every event) but
                    # viewPackage never appeared — likely a Sell Event subtype
                    # without a downloadable package.
                    logger.info(f"  attach: no package button (no docs?) {url}")
                else:
                    # Page didn't hydrate within 12s — slow Lambda Playwright.
                    logger.warning(f"  attach: page never hydrated {url}")
                return results
            try:
                await view_pkg.click()
            except Exception as e:
                logger.warning(f"  attach: viewPackage click failed ({type(e).__name__}) {url}")
                return results
            await page.wait_for_timeout(4000)

            try:
                await page.wait_for_selector(
                    'tr[data-if-cloned-from="ViewAttachmentsTableRow"]', timeout=10000
                )
            except Exception:
                # Modal opened but no rows materialized. Either the package
                # is genuinely empty or hydration ran past the timeout —
                # which we currently can't distinguish from the log alone.
                # When CALEP_MODAL_DEBUG=1 is set on the Lambda, dump the
                # modal's inner HTML to S3 so we can inspect what was
                # actually there. Best-effort: any failure in the dump
                # path is swallowed, the main return path is unchanged.
                await self._maybe_dump_modal(page, url)
                logger.info(f"  attach: package empty / table never rendered {url}")
                return results

            buttons = await page.query_selector_all(
                'tr[data-if-cloned-from="ViewAttachmentsTableRow"] button[data-if-label="ViewAttachmentsView"]'
            )
            n_attachments = len(buttons)

            for i in range(n_attachments):
                filename = f"attachment_{i}.pdf"
                pdf_url = ""
                try:
                    buttons = await page.query_selector_all(
                        'tr[data-if-cloned-from="ViewAttachmentsTableRow"] button[data-if-label="ViewAttachmentsView"]'
                    )
                    if i >= len(buttons):
                        break

                    btn = buttons[i]
                    await btn.scroll_into_view_if_needed()
                    await page.wait_for_timeout(300)
                    # Bypass actionability — modal overlay sometimes blocks normal click
                    try:
                        await btn.click(timeout=5000)
                    except Exception:
                        await btn.evaluate("el => el.click()")

                    await page.wait_for_selector(
                        "#attachmentBox", state="visible", timeout=10000
                    )
                    await page.wait_for_timeout(1000)

                    download_btn = await page.wait_for_selector(
                        "#downloadButton", timeout=5000
                    )
                    if not download_btn:
                        await self._close_attachment_modal(page)
                        continue

                    pdf_url = await download_btn.get_attribute("href") or ""
                    if pdf_url:
                        filename = (
                            pdf_url.split("/")[-1].split("?")[0]
                            or f"attachment_{i}.pdf"
                        )

                    if not pdf_url:
                        await self._close_attachment_modal(page)
                        continue

                    if classify_pdf(filename) == "skip":
                        logger.debug(f"  Skipping {filename} (classified as skip)")
                        await self._close_attachment_modal(page)
                        continue

                    text, body = await self._fetch_pdf_text(page, pdf_url, filename)
                    if text:
                        logger.info(f"  PDF: {filename} ({len(text)} chars)")
                    s3_key = None
                    if body:
                        from webscraping.v2.pipeline.attachments_mirror import mirror_pdf
                        s3_key = mirror_pdf(event_id, filename, body, fallback_index=i)
                        if s3_key:
                            # Eager stash: record the mirror NOW, while we still
                            # have the bytes and before the next iteration's
                            # modal-open timeout can blow up this event entirely.
                            mirror_sink.append({
                                "filename": filename,
                                "s3_key": s3_key,
                                "original_url": pdf_url,
                            })
                    results.append({
                        "filename": filename,
                        "url": pdf_url,
                        "text": text,
                        "s3_key": s3_key,
                    })

                    await self._close_attachment_modal(page)

                except Exception as e:
                    logger.warning(f"Error on attachment #{i + 1} ({filename}): {e}")
                    if pdf_url:
                        results.append({"filename": filename, "url": pdf_url, "text": "", "s3_key": None})
                    await self._close_attachment_modal(page)

        except Exception as e:
            logger.warning(
                f"  attach: unexpected failure ({type(e).__name__}: {e}) {url}"
            )

        return results

    async def _maybe_dump_modal(self, page: Page, event_url: str) -> None:
        """When CALEP_MODAL_DEBUG=1, write the attachment-modal HTML to S3.

        Lets us inspect 'package empty / table never rendered' events
        from the browser side — distinguishing between (a) the package
        is genuinely empty (modal renders an empty-state message) and
        (b) the table is rendered but our selector is wrong (rows
        present under a different attribute). Best-effort; any failure
        is swallowed.

        Cap is enforced via _modal_debug_count so a single Lambda run
        never writes more than a handful of dumps even on long chains.
        """
        import os
        if os.environ.get("CALEP_MODAL_DEBUG", "0") != "1":
            return
        cap = int(os.environ.get("CALEP_MODAL_DEBUG_CAP", "3"))
        if getattr(self, "_modal_debug_count", 0) >= cap:
            return
        try:
            # Wait a bit more — table may render late.
            await page.wait_for_timeout(2500)
            payload = await page.evaluate(
                """() => {
                    const summary = {
                        url: location.href,
                        title: document.title,
                        // What attachment-related data-if-label elements exist?
                        attachment_labels: Array.from(
                            document.querySelectorAll('[data-if-label]')
                        )
                            .map(e => e.getAttribute('data-if-label'))
                            .filter(l => /attach|package|view|download/i.test(l)),
                        // Any tables/rows on the page?
                        table_count: document.querySelectorAll('table').length,
                        tbody_tr_count: document.querySelectorAll('tbody tr').length,
                        // Visible modals
                        any_modal_open: Array.from(
                            document.querySelectorAll('.modal.show, .modal.in')
                        ).map(m => m.id || m.className),
                        // Text from anything attachment-id'd
                        attachment_section_text: Array.from(
                            document.querySelectorAll('[id*="ttachment"], [class*="ttachment"]')
                        )
                            .map(e => (e.innerText || '').trim().slice(0, 200))
                            .filter(Boolean)
                            .slice(0, 10),
                    };
                    return {
                        summary,
                        body_html: document.body ? document.body.outerHTML : '',
                    };
                }"""
            )
            if not payload:
                return
            from webscraping.v2.config import S3_BUCKET, get_s3_client
            import json as _json
            from datetime import datetime
            event_token = event_url.rstrip("/").split("/event/")[-1].replace("/", "_")
            ts = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
            base = f"scrapes/v2/debug/caleprocure_modal/{ts}_{event_token}"
            s3 = get_s3_client()
            s3.put_object(
                Bucket=S3_BUCKET,
                Key=f"{base}.summary.json",
                Body=_json.dumps(payload["summary"], indent=2).encode("utf-8"),
                ContentType="application/json",
            )
            body_html = payload.get("body_html") or ""
            if body_html:
                s3.put_object(
                    Bucket=S3_BUCKET,
                    Key=f"{base}.body.html",
                    Body=body_html.encode("utf-8"),
                    ContentType="text/html",
                )
            logger.info(
                f"  attach: dumped diagnostics for {event_url} → s3://{S3_BUCKET}/{base}.*"
            )
            self._modal_debug_count = getattr(self, "_modal_debug_count", 0) + 1
        except Exception as e:
            logger.debug(f"  attach: modal dump failed: {type(e).__name__}: {e}")

    async def _close_attachment_modal(self, page: Page) -> None:
        """Close the Cal eProcure attachment modal, swallowing any error."""
        try:
            close_btn = await page.query_selector(
                "#attachmentWrapperModal .btn-outline-primary"
            )
            if close_btn:
                try:
                    await close_btn.click(timeout=3000)
                except Exception:
                    await close_btn.evaluate("el => el.click()")
                await page.wait_for_timeout(800)
        except Exception:
            pass

    async def _fetch_pdf_text(
        self, page: Page, pdf_url: str, filename: str
    ) -> tuple[str, bytes | None]:
        """Fetch a session-bound PDF via the browser context, extract text, return both.

        Uses Playwright's APIRequestContext to share cookies with the
        navigated page — sidestepping the click-based download flow that
        was hitting actionability timeouts. Returns (text, body) so the
        caller can mirror the bytes to our S3 bucket; either field is the
        empty value on failure.
        """
        import os
        import tempfile

        from webscraping.v2.pipeline.enrich import extract_text_from_pdf

        tmp_path = None
        try:
            response = await page.context.request.get(pdf_url, timeout=60000)
            if not response.ok:
                logger.warning(
                    f"  Fetch failed for {filename}: HTTP {response.status}"
                )
                return "", None
            body = await response.body()
            if not body or len(body) < 100:
                logger.warning(f"  Empty PDF body for {filename}")
                return "", None

            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False
            ) as tmp:
                tmp.write(body)
                tmp_path = tmp.name

            text = extract_text_from_pdf(tmp_path)
            return text or "", body
        except Exception as e:
            logger.warning(f"  Fetch/extract failed for {filename}: {e}")
            return "", None
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass


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
