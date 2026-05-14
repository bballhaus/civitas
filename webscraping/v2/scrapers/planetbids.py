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
from typing import AsyncIterator, Optional

from playwright.async_api import (
    async_playwright,
    Page,
    TimeoutError as PlaywrightTimeoutError,
)

from webscraping.v2.config import PLANETBIDS_SECRET_NAME, get_secret
from webscraping.v2.models import (
    Award,
    BidResult,
    ContactInfo,
    ProspectiveBidder,
    RawScrapedEvent,
    SiteConfig,
)
from webscraping.v2.scrapers.base import BaseScraper
from webscraping.v2.scrapers.planetbids_parsers import (
    parse_certifications,
    parse_currency,
    parse_pre_bid_attendee,
    parse_responsive,
    parse_vendor_block,
)

logger = logging.getLogger(__name__)

# Known California agencies on PlanetBids (44 verified portals)
PLANETBIDS_AGENCIES: dict[str, dict] = {
    # --- Cities ---
    # vendor_registered=True is a hint that the shared cross-portal
    # account has been registered as a vendor with this agency. In
    # practice, PlanetBids ALSO requires per-BID Prospective Bidder
    # registration to download '*'-prefixed (private) documents — so
    # vendor_registered alone is NOT sufficient to unlock RFP PDFs.
    # The flag is currently a no-op for download purposes; it's kept
    # here so we can revisit if PlanetBids exposes a non-PB download
    # path later, and so portals that DO publish public-only docs can
    # still be marked.
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
    # Pasadena migrated off PlanetBids → OpenGov in early 2026. Removed
    # from registry; the OpenGov scraper picks it up via opengov_pasadena.
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

    # PlanetBids status dropdown values (second select.select-field on bo-search)
    STATUS_BIDDING = "3"
    STATUS_AWARDED = "6"

    def __init__(
        self,
        site_config: SiteConfig,
        include_awarded: bool = False,
        batch_offset: int = 0,
        batch_size: Optional[int] = None,
    ):
        super().__init__(site_config)
        self._portal_url = site_config.config.get("url", site_config.url)
        self._agency_name = site_config.config.get("name", site_config.name)
        self._portal_id = site_config.config.get("portal_id")
        self._authenticated = False
        # When True, we have a per-agency vendor registration (unlocks the
        # Documents tab for full PDF enrichment). Driven by config flag in
        # PLANETBIDS_AGENCIES; default False keeps unregistered portals on
        # the addenda-only path.
        self._vendor_registered = bool(
            site_config.config.get("vendor_registered", False)
        )
        # Pagination — when set, scrape() yields events[batch_offset:batch_offset+batch_size]
        # within a single status pass. Lets the Lambda handler chain batches of N events
        # per invocation so large portals (San Diego, Anaheim) don't hit the 15-min timeout.
        # Only meaningful in single-status mode.
        self.batch_offset = batch_offset
        self.batch_size = batch_size
        # Populated after _scroll_to_load_all so the Lambda chain knows when to stop.
        self.total_available: int = 0
        # Status passes to run. Bidding is current opportunities; Awarded
        # unlocks historical contract data (vendors, amounts, awards).
        self._statuses: list[tuple[str, str]] = [(self.STATUS_BIDDING, "Bidding")]
        if include_awarded:
            self._statuses.append((self.STATUS_AWARDED, "Awarded"))

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        """Scrape open bids from a PlanetBids portal.

        PlanetBids uses an Ember.js SPA with:
        - Filter dropdowns for bid type and status
        - A Search button to apply filters
        - Infinite scroll (loads 30 rows per scroll) inside a .table-overflow-container
        - "Found N bids" count text

        Strategy: filter to "Bidding" status → click Search → scroll to load all rows.
        """
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=[
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
            )
            page = await context.new_page()

            try:
                # Optional vendor login — if creds are available, gives access
                # to documents marked with `*` (vendor-login-required).
                await self._login(page)

                # One pass per status (Bidding always; Awarded if --include-awarded).
                # Each pass: load search page → filter → scroll → extract → enrich.
                for status_code, status_label in self._statuses:
                    logger.info(
                        f"=== {self._agency_name}: scraping status={status_label} ==="
                    )
                    await page.goto(
                        self._portal_url, wait_until="networkidle", timeout=60000
                    )
                    await page.wait_for_timeout(5000)
                    await self._hide_overlays(page)

                    await self._apply_status_filter(page, status_code, status_label)
                    await self._scroll_to_load_all(page)

                    rows = await page.query_selector_all("table tbody tr")
                    logger.info(f"Status={status_label}: {len(rows)} rows loaded")

                    events: list[RawScrapedEvent] = []
                    for row in rows:
                        try:
                            extracted = await self._extract_row(page, row)
                            if extracted:
                                events.append(extracted)
                        except Exception as e:
                            logger.debug(f"Failed to extract row: {e}")

                    self.total_available = len(events)

                    # Pagination: only enrich events in this batch's window.
                    # Single-status mode only; multi-status (--include-awarded)
                    # ignores pagination and does the full pass.
                    enrich_targets = events
                    if self.batch_size is not None and len(self._statuses) == 1:
                        end = self.batch_offset + self.batch_size
                        enrich_targets = events[self.batch_offset:end]
                        logger.info(
                            f"Pagination: enriching events "
                            f"[{self.batch_offset}:{min(end, len(events))}] of {len(events)}"
                        )

                    for i, event in enumerate(enrich_targets):
                        try:
                            self.throttle()
                            await self._enrich_from_detail(
                                page, event, i + 1, len(enrich_targets)
                            )
                        except Exception as e:
                            logger.debug(
                                f"Failed to scrape detail for {event.source_event_id}: {e}"
                            )
                        yield event

            finally:
                await browser.close()

    async def _login(self, page: Page) -> bool:
        """Log in to PlanetBids as a vendor.

        Returns True on success, False on any failure (no creds, network
        error, wrong selector, bad password). On failure the scraper
        continues without auth — public bid listings still work, but
        vendor-login-required documents (marked with *) won't be reachable.

        PlanetBids vendor accounts are domain-scoped to vendors.planetbids.com,
        so one login provides cross-portal access within this browser context.
        """
        if not self._portal_id:
            logger.debug("No portal_id configured; skipping login")
            return False

        try:
            creds = get_secret(PLANETBIDS_SECRET_NAME)
        except Exception as e:
            logger.info(f"PlanetBids creds unavailable ({type(e).__name__}); scraping public-only")
            return False

        username = creds.get("username")
        password = creds.get("password")
        if not username or not password:
            logger.warning("PlanetBids secret missing username/password fields")
            return False

        login_url = f"https://vendors.planetbids.com/portal/{self._portal_id}/login"
        try:
            await page.goto(login_url, wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(2000)

            # Selectors are unknown (Ember SPA); try several common patterns.
            user_selectors = [
                'input[type="email"]',
                'input[name="username"]',
                'input[name="email"]',
                'input[id*="email" i]',
                'input[id*="username" i]',
            ]
            user_field = None
            for sel in user_selectors:
                user_field = await page.query_selector(sel)
                if user_field:
                    break
            if not user_field:
                logger.warning(f"PlanetBids login: username field not found at {login_url}")
                return False

            pass_field = await page.query_selector('input[type="password"]')
            if not pass_field:
                logger.warning("PlanetBids login: password field not found")
                return False

            await user_field.fill(username)
            await pass_field.fill(password)

            submit_selectors = [
                'button[type="submit"]',
                'button:has-text("Sign In")',
                'button:has-text("Sign in")',
                'button:has-text("Login")',
                'button:has-text("Log In")',
                'input[type="submit"]',
            ]
            submit_btn = None
            for sel in submit_selectors:
                submit_btn = await page.query_selector(sel)
                if submit_btn:
                    break
            if not submit_btn:
                logger.warning("PlanetBids login: submit button not found")
                return False

            await submit_btn.click()
            # Login is an XHR; wait for redirect away from /login.
            try:
                await page.wait_for_url(
                    lambda url: "/login" not in url, timeout=15000
                )
            except Exception:
                pass
            await page.wait_for_timeout(2000)

            # Verify: URL no longer on /login, and no visible error message.
            current_url = page.url
            if "/login" in current_url:
                # Check for an error message near the form
                err_text = await page.evaluate("""() => {
                    const body = document.body.innerText.toLowerCase();
                    const errs = ['invalid', 'incorrect', 'failed', 'try again'];
                    return errs.find(e => body.includes(e)) || '';
                }""")
                logger.warning(f"PlanetBids login appears to have failed (still on /login, hint: '{err_text}')")
                return False

            self._authenticated = True
            logger.info(f"PlanetBids login OK as {username}")
            return True

        except Exception as e:
            logger.warning(f"PlanetBids login error: {e}")
            return False

    @staticmethod
    async def _hide_overlays(page: Page):
        """Remove third-party overlays that intercept pointer events.

        Authenticated PlanetBids sessions get a ProductFruits onboarding
        overlay that overlays the page and silently swallows clicks. Removing
        the container is harmless to scraping.
        """
        try:
            await page.evaluate(
                """() => {
                    const sels = [
                        '.productfruits--container',
                        '[id^="productfruits"]',
                        '.intercom-lightweight-app',
                    ];
                    for (const sel of sels) {
                        document.querySelectorAll(sel).forEach(el => el.remove());
                    }
                }"""
            )
        except Exception:
            pass

    async def _apply_status_filter(self, page: Page, status_code: str, status_label: str):
        """Select a status (Bidding/Awarded/etc.) on the dropdown and click Search.

        Status dropdown values (second select.select-field):
            0=All, 2=Planning, 3=Bidding, 4=Closed,
            5=Award Pending, 6=Awarded, 7=Canceled, 8=Rejected
        """
        try:
            selects = await page.query_selector_all("select.select-field")
            if len(selects) < 2:
                logger.warning("Could not find status filter dropdown")
                return
            await selects[1].select_option(status_code)
            await page.wait_for_timeout(500)
            logger.info(f"Selected '{status_label}' status filter")

            await self._hide_overlays(page)

            search_btn = await page.query_selector(
                'button:has-text("Search"), input[type="submit"], '
                'button[type="submit"]'
            )
            if search_btn:
                await search_btn.click()
                await page.wait_for_timeout(3000)

            count = await page.evaluate(
                """() => {
                    const m = document.body.innerText.match(/Found\\s+(\\d+)\\s+bids/i);
                    return m ? parseInt(m[1]) : -1;
                }"""
            )
            if count >= 0:
                logger.info(f"Found {count} {status_label} bids after filtering")
        except Exception as e:
            logger.warning(f"Failed to apply status filter ({status_label}): {e}")

    async def _scroll_to_load_all(self, page: Page, max_scrolls: int = 50):
        """Scroll the table container to trigger infinite scroll loading."""
        prev_count = 0
        for i in range(max_scrolls):
            self.throttle()
            await page.evaluate("""() => {
                const container = document.querySelector('.table-overflow-container');
                if (container) {
                    container.scrollTop = container.scrollHeight;
                } else {
                    window.scrollTo(0, document.body.scrollHeight);
                }
            }""")
            await page.wait_for_timeout(2000)

            rows = await page.query_selector_all("table tbody tr")
            current_count = len(rows)
            if current_count == prev_count:
                # No new rows loaded — we've reached the end
                break
            logger.debug(f"Scroll {i + 1}: {current_count} rows loaded")
            prev_count = current_count

    async def _enrich_from_detail(
        self, page: Page, event: RawScrapedEvent, index: int, total: int
    ):
        """Navigate to a bid's detail page and extract description, contact, and addenda.

        PlanetBids is an SPA — clicking a row navigates to the detail view.
        We extract public data, then click "Back to Bid Search" to return.

        Modifies the event in-place with enriched data.
        """
        if not event.source_url or event.source_url == page.url:
            return

        try:
            await page.goto(event.source_url, wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(2000)
            await self._hide_overlays(page)

            # Extract description, contact, and categories from detail page
            detail = await page.evaluate("""() => {
                const text = document.body.innerText;
                const info = {};

                // Description / Scope
                const descMatch = text.match(/(?:Description|Scope of Services)\\n([\\s\\S]*?)(?:\\nOther Details|\\nNotes|$)/);
                info.description = descMatch ? descMatch[1].trim().substring(0, 2000) : '';

                // Contact info
                const contactMatch = text.match(/Contact Info\\n([\\s\\S]*?)(?:\\nBids to|\\nOwner|$)/);
                if (contactMatch) {
                    const block = contactMatch[1].trim();
                    info.contact_text = block;
                    const emailMatch = block.match(/[\\w.+-]+@[\\w.-]+\\.\\w+/);
                    const phoneMatch = block.match(/[\\(]?\\d{3}[\\).\\-\\s]?\\d{3}[.\\-\\s]?\\d{4}/);
                    // Name is typically the first line
                    const lines = block.split('\\n').map(l => l.trim()).filter(l => l);
                    info.contact_name = lines[0] || '';
                    info.contact_email = emailMatch ? emailMatch[0] : '';
                    info.contact_phone = phoneMatch ? phoneMatch[0] : '';
                }

                // Categories (like NAICS)
                const catSection = text.match(/Categories\\n([\\s\\S]*?)(?:\\nDepartment|$)/);
                if (catSection) {
                    info.categories = catSection[1].trim().split('\\n').map(l => l.trim()).filter(l => l);
                } else {
                    info.categories = [];
                }

                return info;
            }""")

            # Update event with detail data
            if detail.get("description"):
                event.description = detail["description"]
            if detail.get("contact_name") or detail.get("contact_email"):
                event.contact = ContactInfo(
                    name=detail.get("contact_name") or None,
                    email=detail.get("contact_email") or None,
                    phone=detail.get("contact_phone") or None,
                )
            if detail.get("categories"):
                event.raw_metadata["categories"] = detail["categories"]

            # Click "Documents" tab and collect public addenda URLs
            docs_tab = await page.query_selector('a:has-text("Documents"), button:has-text("Documents")')
            if docs_tab:
                await docs_tab.click()
                await page.wait_for_timeout(2000)

                # Extract public document names (items without * prefix = no login required)
                doc_info = await page.evaluate("""() => {
                    const rows = document.querySelectorAll('table tr');
                    const docs = [];
                    for (const row of rows) {
                        const text = row.textContent.trim();
                        // Skip header rows and login-required docs (marked with *)
                        if (text.startsWith('Title') || text.startsWith('*')) continue;
                        // Look for PDF filenames
                        const pdfMatch = text.match(/([\\w\\-\\s]+\\.pdf)/i);
                        if (pdfMatch) {
                            docs.push(pdfMatch[1].trim());
                        }
                    }
                    return docs;
                }""")
                if doc_info:
                    event.raw_metadata["public_documents"] = doc_info
                    logger.debug(f"  Found {len(doc_info)} public documents")

                # Vendor-registered portals get full Documents-tab download.
                # The shared cross-portal login already ran; per-agency
                # registration on the SAME account unlocks gated PDFs once
                # the vendor_registered flag is set in PLANETBIDS_AGENCIES.
                if self._vendor_registered and self._authenticated:
                    try:
                        await self._download_documents_tab(page, event)
                    except Exception as e:
                        logger.warning(
                            f"  Documents-tab download failed for "
                            f"{event.source_event_id}: {e}"
                        )

            # Market intel — Prospective Bidders / Bid Results / Awards
            # Requires the basic vendor login (NOT per-agency registration)
            await self._scrape_market_intel(page, event)

            logger.info(
                f"[{index}/{total}] Detail: {event.title[:50]} | "
                f"{len(detail.get('categories', []))} cats, "
                f"{len(event.prospective_bidders)} prospective bidders, "
                f"{len(event.bid_results)} bid results, "
                f"award={'yes' if event.award else 'no'}"
            )

        except Exception as e:
            logger.debug(f"Detail page failed for {event.source_event_id}: {e}")

        # Navigate back to search results for the next event
        try:
            back_btn = await page.query_selector('a:has-text("Back to Bid Search")')
            if back_btn:
                await back_btn.click()
                await page.wait_for_timeout(2000)
            else:
                await page.go_back()
                await page.wait_for_timeout(2000)
        except Exception:
            pass

    async def _download_documents_tab(self, page: Page, event: RawScrapedEvent):
        """For vendor-registered portals: download every PDF in Documents tab.

        PlanetBids' Documents tab is an Angular SPA: each row's Download
        and View controls are anchors with href="#" plus a click handler
        that issues an authenticated request and streams the file. There
        is no scrapeable PDF URL on the row, so we trigger each anchor
        click and capture the resulting download via expect_download.

        Assumes the caller already clicked the Documents tab.

        Stashes per-PDF text into `event.raw_metadata["attachment_texts"]`
        so the existing `enrich_event` pipeline picks it up. Adds entries
        to `event.attachment_urls` with placeholder URLs (the actual
        download URL is session-bound and not persisted).
        """
        import os
        import tempfile
        from webscraping.v2.pipeline.enrich import (
            classify_pdf,
            extract_text_from_pdf,
        )

        # Find every Download anchor inside any documents-section table
        # row. Each row is one PDF; the anchor has visible text "Download".
        download_handles = await page.query_selector_all(
            'table tbody tr a:has-text("Download"), '
            'table tbody tr button:has-text("Download")'
        )
        if not download_handles:
            logger.debug(
                f"  Documents tab: no Download controls found on "
                f"{event.source_event_id}"
            )
            return

        # Pull a filename hint per row so we can name the saved file.
        filenames = await page.evaluate(
            """() => {
                const rows = document.querySelectorAll('table tbody tr');
                const out = [];
                for (const r of rows) {
                    const tds = r.querySelectorAll('td');
                    let fname = '';
                    for (const td of tds) {
                        const t = (td.textContent || '').trim();
                        if (/\\.pdf$/i.test(t)) {
                            fname = t;
                            break;
                        }
                    }
                    if (!fname && tds.length >= 2) {
                        fname = (tds[1].textContent || '').trim();
                    }
                    out.push(fname);
                }
                return out;
            }"""
        )

        attachment_texts: dict[str, str] = {}
        urls_kept: list[str] = []

        gated_count = 0
        for i, handle in enumerate(download_handles):
            filename = (
                filenames[i] if i < len(filenames) and filenames[i]
                else f"document_{i+1}.pdf"
            )
            if not filename.lower().endswith(".pdf"):
                filename = f"{filename}.pdf"
            if classify_pdf(filename) == "skip":
                continue

            tmp_path = None
            try:
                await handle.scroll_into_view_if_needed()
                async with page.expect_download(timeout=20000) as dl_info:
                    try:
                        await handle.click(timeout=10000)
                    except Exception:
                        await handle.evaluate("el => el.click()")
                download = await dl_info.value
                tmp_path = await download.path()
                if not tmp_path:
                    continue

                try:
                    sz = os.path.getsize(tmp_path)
                except OSError:
                    sz = 0
                if sz < 100:
                    continue

                text = extract_text_from_pdf(tmp_path)
                if text:
                    attachment_texts[filename] = text
                    placeholder_url = (
                        f"planetbids://{self._portal_id}/"
                        f"{event.source_event_id}/{filename}"
                    )
                    urls_kept.append(placeholder_url)
                    logger.info(f"  Doc: {filename} ({len(text)} chars)")
            except PlaywrightTimeoutError:
                # No download fired within 20s. The likely reason is that
                # PlanetBids opened a "Become a Prospective Bidder" modal
                # blocking access to gated (`*`-prefixed) documents. Detect
                # the modal explicitly so the log carries the real reason.
                blocked = await page.evaluate(
                    """() => {
                        const t = (document.body ? document.body.innerText : '')
                            .slice(0, 1500).toLowerCase();
                        return t.includes('become a prospective bidder') ||
                               t.includes('must become a prospective bidder');
                    }"""
                )
                if blocked:
                    gated_count += 1
                    logger.debug(
                        f"  Doc gated behind 'Become a Prospective Bidder' "
                        f"modal: {filename}"
                    )
                    # Dismiss the modal so the next row can be tried.
                    try:
                        cancel = await page.query_selector(
                            'button:has-text("Cancel")'
                        )
                        if cancel:
                            await cancel.click(timeout=3000)
                            await page.wait_for_timeout(500)
                    except Exception:
                        pass
                else:
                    logger.warning(
                        f"  Doc download timed out (no PB modal): {filename}"
                    )
            except Exception as e:
                logger.warning(
                    f"  Doc click/download failed for {filename}: {e}"
                )
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass

        if gated_count:
            logger.info(
                f"  {gated_count} doc(s) gated behind per-bid Prospective "
                f"Bidder registration on {event.source_event_id}"
            )

        if attachment_texts:
            existing = event.raw_metadata.get("attachment_texts", {}) or {}
            existing.update(attachment_texts)
            event.raw_metadata["attachment_texts"] = existing
            for u in urls_kept:
                if u not in event.attachment_urls:
                    event.attachment_urls.append(u)

    async def _download_documents_tab_legacy_fetch(self, page: Page, event):
        """Old anchor-href fetch path. Retained as a no-op stub for any
        future portals that DO expose direct PDF hrefs (none observed
        today). The new flow above handles PlanetBids' click-handler UI."""
        import os
        import tempfile
        from webscraping.v2.pipeline.enrich import (
            classify_pdf,
            extract_text_from_pdf,
        )

        doc_links = await page.evaluate(
            """() => {
                const out = [];
                const anchors = document.querySelectorAll('a[href]');
                for (const a of anchors) {
                    const href = a.href || '';
                    if (!href || !/\\.pdf(\\?|$)/i.test(href)) continue;
                    const filename = (a.textContent || '').trim() ||
                                     href.split('/').pop().split('?')[0];
                    out.push({ url: href, filename });
                }
                return out;
            }"""
        )

        if not doc_links:
            return

        attachment_texts: dict[str, str] = {}
        urls_kept: list[str] = []

        for entry in doc_links:
            url = entry.get("url", "")
            filename = (entry.get("filename") or "").strip() or "document.pdf"
            if not filename.lower().endswith(".pdf"):
                filename = f"{filename}.pdf"
            if classify_pdf(filename) == "skip":
                continue

            tmp_path = None
            try:
                resp = await page.context.request.get(url, timeout=60000)
                if not resp.ok:
                    logger.debug(
                        f"  Doc fetch HTTP {resp.status} for {filename}"
                    )
                    continue
                body = await resp.body()
                if not body or len(body) < 100:
                    continue
                with tempfile.NamedTemporaryFile(
                    suffix=".pdf", delete=False
                ) as tmp:
                    tmp.write(body)
                    tmp_path = tmp.name
                text = extract_text_from_pdf(tmp_path)
                if text:
                    attachment_texts[filename] = text
                    urls_kept.append(url)
                    logger.info(f"  Doc: {filename} ({len(text)} chars)")
            except Exception as e:
                logger.debug(f"  Doc fetch failed {filename}: {e}")
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass

        if attachment_texts:
            existing = event.raw_metadata.get("attachment_texts", {}) or {}
            existing.update(attachment_texts)
            event.raw_metadata["attachment_texts"] = existing
            for u in urls_kept:
                if u not in event.attachment_urls:
                    event.attachment_urls.append(u)

    async def _scrape_market_intel(self, page: Page, event: RawScrapedEvent):
        """Click Prospective Bidders / Bid Results / Awards tabs and parse rows.

        These tabs require the basic vendor login (already done in `_login`)
        but, unlike Documents, do NOT require per-agency vendor registration.
        Empty tabs (e.g. Bid Results on a still-bidding RFP) are normal —
        we just record empty lists.

        Mutates `event.prospective_bidders`, `event.bid_results`, `event.award`.
        """
        if not self._authenticated:
            return

        # Prospective Bidders
        rows = await self._click_tab_and_get_rows(page, "Prospective Bidders")
        event.prospective_bidders = self._parse_prospective_bidders(rows)

        # Bid Results (closed/awarded only)
        rows = await self._click_tab_and_get_rows(page, "Bid Results")
        event.bid_results = self._parse_bid_results(rows)

        # Awards (awarded only)
        event.award = await self._scrape_award_tab(page)

    async def _click_tab_and_get_rows(self, page: Page, tab_name: str) -> list[list[str]]:
        """Click a detail-page tab and return its data table rows as cell-text lists.

        Returns [] on any failure or if the tab redirects to a registration prompt
        (which can happen for some tabs on some agency portals).
        """
        await self._hide_overlays(page)
        el = await page.query_selector(
            f'a:has-text("{tab_name}"), button:has-text("{tab_name}")'
        )
        if not el:
            return []
        try:
            await el.click()
        except Exception as e:
            logger.debug(f"Tab '{tab_name}' click failed: {e}")
            return []
        await page.wait_for_timeout(2000)

        # Detect redirect to a registration / pre-reg page
        if "/vp-prereg" in page.url or "/vp/vp-prereg" in page.url:
            logger.debug(f"Tab '{tab_name}' redirected to registration; skipping")
            return []

        try:
            return await page.evaluate(
                """() => {
                    // Each row's cells, each cell as innerText (preserves newlines).
                    const out = [];
                    for (const tr of document.querySelectorAll('table tr')) {
                        const cells = tr.querySelectorAll('td');
                        if (!cells.length) continue;
                        out.push([...cells].map(c => c.innerText));
                    }
                    return out;
                }"""
            )
        except Exception:
            return []

    # Classification cell values seen on PlanetBids
    _CLASSIFICATION_TOKENS = {"bidder", "subcontractor", "plan room", "subscriber"}

    @staticmethod
    def _classify_cell(text: str) -> str:
        """Categorize an auxiliary cell by content pattern."""
        t = (text or "").strip()
        low = t.lower()
        if not t:
            return "empty"
        if "$" in t:
            return "amount"
        if low in ("yes", "no"):
            return "yesno"
        if low in PlanetBidsScraper._CLASSIFICATION_TOKENS:
            return "type"
        # Comma-separated short tokens → certs
        if "," in t and not re.search(r"\d{3,}", t):
            return "certs"
        return "other"

    def _parse_prospective_bidders(self, rows: list[list[str]]) -> list[ProspectiveBidder]:
        out: list[ProspectiveBidder] = []
        for cells in rows:
            if not cells:
                continue
            vendor = parse_vendor_block(cells[0])
            if not vendor:
                continue
            classification = None
            attendee_text = None
            for c in cells[1:]:
                kind = self._classify_cell(c)
                if kind == "certs":
                    vendor.certifications = parse_certifications(c)
                elif kind == "type" and not classification:
                    classification = c.strip()
                elif kind == "yesno" and not attendee_text:
                    attendee_text = c
            out.append(
                ProspectiveBidder(
                    vendor=vendor,
                    classification=classification,
                    pre_bid_attendee=parse_pre_bid_attendee(attendee_text),
                )
            )
        return out

    def _parse_bid_results(self, rows: list[list[str]]) -> list[BidResult]:
        out: list[BidResult] = []
        for cells in rows:
            if not cells:
                continue
            vendor = parse_vendor_block(cells[0])
            if not vendor:
                continue
            amount_cell = None
            responsive_cell = None
            for c in cells[1:]:
                kind = self._classify_cell(c)
                if kind == "certs":
                    vendor.certifications = parse_certifications(c)
                elif kind == "amount" and not amount_cell:
                    amount_cell = c
                elif kind == "yesno" and not responsive_cell:
                    responsive_cell = c
            out.append(
                BidResult(
                    vendor=vendor,
                    amount_cents=parse_currency(amount_cell),
                    amount_display=amount_cell.strip() if amount_cell else None,
                    responsive=parse_responsive(responsive_cell),
                )
            )
        return out

    async def _scrape_award_tab(self, page: Page) -> Optional[Award]:
        """Click Awards tab; return an Award if there's content, else None.

        The Awards tab format varies more than the table tabs — sometimes a
        free-text summary, sometimes a table. We capture the raw text for
        explainability and best-effort-extract a dollar amount; deeper
        parsing (vendor identity, date) is a follow-up enrichment.
        """
        await self._hide_overlays(page)
        el = await page.query_selector('a:has-text("Awards"), button:has-text("Awards")')
        if not el:
            return None
        try:
            await el.click()
        except Exception:
            return None
        await page.wait_for_timeout(2000)
        if "/vp-prereg" in page.url:
            return None

        try:
            text = await page.evaluate(
                """() => {
                    // Awards tab content is rendered into the active tabpanel
                    const panel = document.querySelector('[role="tabpanel"]');
                    const t = (panel || document.body).innerText || '';
                    return t.length > 4000 ? t.slice(0, 4000) : t;
                }"""
            )
        except Exception:
            return None

        if not text:
            return None
        # PlanetBids' standard sentinels for unfinalized awards
        lowered = text.lower()
        if any(s in lowered for s in (
            "has not been made public",
            "no award",
            "no information",
            "not yet awarded",
        )):
            return None
        # Strip Awards-tab heading boilerplate if that's all there is
        if text.strip().lower() == "awards":
            return None

        amount_match = re.search(r"\$\s?[\d,]+(?:\.\d{2})?", text)
        amount_display = amount_match.group(0).strip() if amount_match else None

        return Award(
            amount_cents=parse_currency(text),
            amount_display=amount_display,
            raw_text=text[:2000],
        )

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

_PB_S3_REGISTRY_KEY = "scrapes/v2/registry/planetbids.json"


def _load_planetbids_from_s3() -> dict[str, dict]:
    """Load PlanetBids agencies onboarded dynamically (smart-router path).

    Same pattern as OpenGov's S3 registry: the smart router writes a
    `{site_id: {portal_id, name, url}}` dict here when an exploration
    candidate verifies as PlanetBids. Reads are best-effort.
    """
    try:
        import json as _json
        from webscraping.v2.config import S3_BUCKET, get_s3_client
        s3 = get_s3_client()
        resp = s3.get_object(Bucket=S3_BUCKET, Key=_PB_S3_REGISTRY_KEY)
        data = _json.loads(resp["Body"].read())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def get_planetbids_site_configs() -> dict[str, SiteConfig]:
    """Generate SiteConfig entries for all known PlanetBids agencies.

    In-code (`PLANETBIDS_AGENCIES`) wins over S3-onboarded entries on
    site_id collisions, so manual overrides via deploy still hold.
    """
    merged: dict[str, dict] = {}
    merged.update(_load_planetbids_from_s3())
    merged.update(PLANETBIDS_AGENCIES)  # code wins

    configs = {}
    for site_id, agency in merged.items():
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
                "vendor_registered": agency.get("vendor_registered", False),
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
