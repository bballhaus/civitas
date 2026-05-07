"""
OpenGov Procurement scraper — multi-tenant Tier-2 structured scraper.

OpenGov Procurement (formerly ProcureNow) is a SaaS platform many CA
cities have migrated onto, including Pasadena. Each agency lives at
`https://procurement.opengov.com/portal/{slug}` with a near-identical
DOM, so a single scraper covers many agencies.

Sites are added by appending an entry to OPENGOV_AGENCIES; the runner
picks them up automatically through `get_opengov_site_configs`.

Cloudflare bot-detection is in front of OpenGov, so we use the same
stealth Playwright setup (custom UA, headless tweaks, navigator.webdriver
mask) that the agentic scraper uses.

PDF documents on OpenGov are typically public — no login flow needed.
PDFs are downloaded inline via `page.context.request.get` so the
existing enrich pipeline picks them up via `attachment_texts`.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile
from typing import AsyncIterator, Optional
from urllib.parse import urljoin, urlparse

from playwright.async_api import async_playwright, Page

from webscraping.v2.config import get_scrapingbee_proxy
from webscraping.v2.models import ContactInfo, RawScrapedEvent, SiteConfig
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


# How many bid detail pages to scrape per Lambda invocation. The full
# OpenGov bid listing per portal is small (typically 5-30 active bids),
# so the whole portal usually fits in one Lambda invocation.
DEFAULT_BATCH_SIZE = 12

MAX_PDFS_PER_EVENT = 12  # Defensive cap on attachments.


class OpenGovScraper(BaseScraper):
    """Multi-tenant OpenGov Procurement scraper.

    Strategy:
    1. Load /portal/{slug} (or its /projects sub-route).
    2. Walk the bid cards, capture title/agency/deadline + detail URL.
    3. For each bid: navigate, extract description/contact, find every
       <a> pointing to a PDF, fetch via the browser's request context,
       extract text with PyMuPDF, stash on the event for enrichment.
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
        # OpenGov is behind Cloudflare bot detection — headless Chromium
        # alone (with stealth init scripts) does not pass the "Just a
        # moment" challenge. We route through ScrapingBee's stealth
        # proxy when SCRAPINGBEE_API_KEY is configured. Without a key
        # the scraper still launches but Cloudflare will block it; the
        # log line below makes that explicit so degraded operation is
        # visible in CloudWatch.
        proxy_cfg = get_scrapingbee_proxy()
        if proxy_cfg:
            logger.info(
                f"[{self.source_id}] Routing through ScrapingBee stealth proxy"
            )
        else:
            logger.warning(
                f"[{self.source_id}] No ScrapingBee key — Cloudflare will "
                f"likely block this run. Set SCRAPINGBEE_API_KEY."
            )
        async with async_playwright() as p:
            launch_kwargs = {
                "headless": True,
                "args": [
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--single-process",
                ],
            }
            if proxy_cfg:
                launch_kwargs["proxy"] = proxy_cfg
            browser = await p.chromium.launch(**launch_kwargs)
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
                'Object.defineProperty(navigator, "webdriver", '
                '{get: () => undefined});'
            )
            page = await context.new_page()

            try:
                bid_links = await self._discover_bids(page)
                self.total_available = len(bid_links)
                logger.info(
                    f"[{self.source_id}] Found {len(bid_links)} bids; "
                    f"slicing [{self.batch_offset}:"
                    f"{self.batch_offset + self.batch_size}]"
                )
                end = self.batch_offset + self.batch_size
                for entry in bid_links[self.batch_offset:end]:
                    try:
                        self.throttle()
                        event = await self._scrape_bid_detail(page, entry)
                        if event:
                            yield event
                    except Exception as e:
                        logger.warning(
                            f"[{self.source_id}] Detail failed for "
                            f"{entry.get('url', '?')}: {e}"
                        )
            finally:
                await browser.close()

    async def _discover_bids(self, page: Page) -> list[dict]:
        """Load the portal listing and return [{title, url, ...}, ...]."""
        listing_urls = [
            self._portal_url.rstrip("/"),
            f"{self._portal_url.rstrip('/')}/projects",
        ]

        for url in listing_urls:
            try:
                await page.goto(url, wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(3000)
            except Exception as e:
                logger.debug(f"  goto {url} failed: {e}")
                continue

            # OpenGov renders bid cards as <a> with /projects/{id} hrefs.
            entries = await page.evaluate(
                """() => {
                    const seen = new Set();
                    const out = [];
                    const anchors = document.querySelectorAll('a[href]');
                    for (const a of anchors) {
                        const href = a.href || '';
                        if (!href) continue;
                        // Match /portal/{slug}/projects/{id} routes
                        if (!/\\/projects\\/[\\w-]+/i.test(href)) continue;
                        if (seen.has(href)) continue;
                        seen.add(href);
                        const title = (a.textContent || '').trim() ||
                                      (a.getAttribute('aria-label') || '').trim();
                        out.push({ url: href, title });
                    }
                    return out;
                }"""
            )

            if entries:
                return entries

        return []

    async def _scrape_bid_detail(
        self, page: Page, entry: dict
    ) -> Optional[RawScrapedEvent]:
        url = entry.get("url", "")
        if not url:
            return None

        await page.goto(url, wait_until="networkidle", timeout=60000)
        await page.wait_for_timeout(2500)

        meta = await page.evaluate(
            """() => {
                function pickByLabel(labels) {
                    const all = document.querySelectorAll(
                        'div, dt, dd, li, span, p, h1, h2, h3, h4'
                    );
                    for (const el of all) {
                        const t = (el.textContent || '').trim();
                        for (const lbl of labels) {
                            if (t.toLowerCase().startsWith(lbl.toLowerCase())) {
                                return t.slice(lbl.length).trim().replace(/^[:\\s]+/, '');
                            }
                        }
                    }
                    return '';
                }
                const titleEl = document.querySelector('h1, h2');
                const title = titleEl ? titleEl.textContent.trim() : '';
                const description = (
                    document.querySelector('[data-testid*="description"], .description, article p')
                    || document.body
                ).innerText.slice(0, 4000);
                const deadline = pickByLabel(['Due Date', 'Closes', 'Closing', 'Deadline', 'Bid Due']);
                const posted = pickByLabel(['Posted', 'Open Date', 'Issued']);
                const contact_email = (() => {
                    const a = document.querySelector('a[href^="mailto:"]');
                    return a ? a.getAttribute('href').replace('mailto:', '') : '';
                })();
                return { title, description, deadline, posted, contact_email };
            }"""
        )

        title = (meta.get("title") or entry.get("title") or "").strip()
        if not title:
            return None

        event_id = self._extract_event_id(url) or title[:80]

        event = RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=event_id,
            source_url=url,
            title=title,
            description=(meta.get("description") or "").strip(),
            issuing_agency=self._agency_name,
            posted_date=meta.get("posted") or "",
            due_date=meta.get("deadline") or "",
            contact=ContactInfo(
                email=meta.get("contact_email") or None,
            ),
            procurement_type="RFP",
        )

        await self._download_pdfs(page, event)

        logger.info(
            f"[{self.source_id}] Scraped: {title[:60]} "
            f"({len(event.attachment_urls)} PDFs)"
        )
        return event

    async def _download_pdfs(self, page: Page, event: RawScrapedEvent) -> None:
        """Find PDF anchors and inline-fetch them via the browser context."""
        from webscraping.v2.pipeline.enrich import (
            classify_pdf,
            extract_text_from_pdf,
        )

        pdf_links = await page.evaluate(
            """() => {
                const seen = new Set();
                const out = [];
                const anchors = document.querySelectorAll('a[href]');
                for (const a of anchors) {
                    const href = a.href || '';
                    if (!href) continue;
                    const lower = href.toLowerCase();
                    if (
                        !lower.includes('.pdf') &&
                        !lower.includes('/document/') &&
                        !lower.includes('/file/') &&
                        !lower.includes('attachment')
                    ) continue;
                    if (seen.has(href)) continue;
                    seen.add(href);
                    const filename =
                        a.getAttribute('download') ||
                        (a.textContent || '').trim() ||
                        href.split('/').pop().split('?')[0];
                    out.push({ url: href, filename });
                }
                return out;
            }"""
        )

        if not pdf_links:
            return

        attachment_texts: dict[str, str] = {}
        for entry in pdf_links[:MAX_PDFS_PER_EVENT]:
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
                    if url not in event.attachment_urls:
                        event.attachment_urls.append(url)
                    logger.info(
                        f"  PDF: {filename} ({len(text)} chars)"
                    )
            except Exception as e:
                logger.debug(f"  PDF fetch failed {filename}: {e}")
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

    @staticmethod
    def _extract_event_id(url: str) -> str:
        """Pull the trailing project id from /projects/{id}."""
        m = re.search(r"/projects/([\w-]+)", url)
        return m.group(1) if m else ""


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
        print(f"    PDFs: {len(e.attachment_urls)}")


if __name__ == "__main__":
    asyncio.run(main())
