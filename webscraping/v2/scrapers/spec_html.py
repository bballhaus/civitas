"""
HTML spec scraper — companion to `SpecDrivenScraper`, but for specs the
investigation agent emits as `response_format=html`.

When the agent's goal hierarchy falls through past clean JSON APIs and
the only option is "load the rendered page and parse the DOM", it emits
an HTML spec. Confidence is usually `low` because DOM-based scrapers
are the brittlest — selectors break the moment the agency redesigns
their portal. We accept that brittleness as the cost of coverage for
portals that lack a clean API.

## Spec field reinterpretation for HTML

The `InvestigationSpec` model was designed JSON-first. For HTML specs,
the same fields carry different semantics:

| Field                            | JSON meaning                 | HTML meaning                              |
|----------------------------------|------------------------------|-------------------------------------------|
| `listing.rows_path`              | dotted JSON path             | CSS selector for each row container       |
| `listing.row_id_field`           | JSON field name              | CSS selector OR attribute name for row id |
| `listing.row_title_field`        | JSON field name              | CSS selector for row title                |
| `detail.summary_field`           | JSON field name              | CSS selector for detail description       |
| `detail.attachment_array_path`   | dotted JSON path             | CSS selector for attachment links         |
| `detail.attachment_url_field`    | JSON field name              | attribute name (default "href")           |

Two conventions for `row_id_field` in HTML mode:
  - Plain attribute name (e.g. `data-bid-id`, `id`) — read from the row.
  - CSS selector with `@attr` suffix (e.g. `a@href`) — find the matching
    element inside the row, take that attribute.

## Rendering

Playwright (headless Chromium) only — most procurement portals that
need an HTML scraper are SPAs whose listing is JS-rendered. A pure-
`requests` path would silently miss content. The Lambda image already
ships with Chromium for the other agentic scrapers.

## Out of scope (deliberate)

- PDF attachment download. HTML specs rarely surface stable per-PDF
  URLs in the listing; when they do, the investigation agent can
  populate `detail.attachment_array_path` and we use it. Otherwise
  we ship the event with no attachments — the rest of the pipeline
  copes.
- Pagination beyond a single page. Agentic HTML scrapers are scoped
  to the first listing page in v1; multi-page traversal is additive
  and adds significant brittleness.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import AsyncIterator, Optional

from playwright.async_api import Page, async_playwright

from webscraping.v2.agents.site_investigation import InvestigationSpec
from webscraping.v2.models import ContactInfo, RawScrapedEvent, SiteConfig
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)


_DEFAULT_BATCH_SIZE = 25
_LOAD_TIMEOUT_MS = 45000
_SETTLE_MS = 2500
_WHITESPACE_RE = re.compile(r"\s+")
# `selector@attr` form for row_id_field in HTML mode — see module docstring.
_ATTR_REF_RE = re.compile(r"^(.+?)@([\w-]+)$")


def _collapse(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text or "").strip()


def _absolutize(href: str, base_url: str) -> str:
    """Normalise a href against the page URL. Handles `/foo`, `?bar`, full URLs."""
    if not href:
        return ""
    if href.startswith(("http://", "https://", "mailto:")):
        return href
    if href.startswith("//"):
        return "https:" + href
    # Best-effort base-relative join without urllib (keeps deps trivial).
    from urllib.parse import urljoin
    return urljoin(base_url, href)


class HtmlSpecScraper(BaseScraper):
    """Spec-driven scraper for `response_format=html` specs.

    See module docstring for the HTML-mode field reinterpretation.
    """

    def __init__(
        self,
        site_config: SiteConfig,
        batch_offset: int = 0,
        batch_size: Optional[int] = None,
    ):
        super().__init__(site_config)
        cfg = site_config.config or {}

        spec_dict = cfg.get("spec")
        if not spec_dict:
            raise ValueError(
                f"HtmlSpecScraper requires site_config.config['spec'] "
                f"(an InvestigationSpec dict). Site: {site_config.site_id}"
            )
        self.spec: InvestigationSpec = InvestigationSpec.model_validate(spec_dict)

        self._slug: str = cfg.get("slug", "")
        self._agency_name: str = cfg.get("name", site_config.name)
        self._portal_url: str = cfg.get("url", site_config.url)

        self.batch_offset = batch_offset
        self.batch_size = batch_size or _DEFAULT_BATCH_SIZE
        self.total_available: int = 0

    # ------------------------------------------------------------------
    # Top-level
    # ------------------------------------------------------------------

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        if self.spec.listing.response_format != "html":
            raise ValueError(
                f"HtmlSpecScraper requires response_format=html, "
                f"got {self.spec.listing.response_format!r}"
            )

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
            try:
                context = await browser.new_context(
                    viewport={"width": 1440, "height": 900},
                    user_agent=(
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"
                    ),
                    locale="en-US",
                    timezone_id="America/Los_Angeles",
                )
                page = await context.new_page()

                rows_data = await self._fetch_listing(page)
                logger.info(
                    f"[{self.source_id}] HTML listing: {len(rows_data)} rows "
                    f"(spec confidence={self.spec.confidence})"
                )

                # Apply batch slicing client-side. HTML pagination is too
                # spec-specific to model uniformly in v1; we scope to one
                # rendered page and slice from that.
                start = self.batch_offset
                end = start + self.batch_size
                for row in rows_data[start:end]:
                    try:
                        event = await self._process_row(page, row)
                    except Exception as e:
                        logger.warning(
                            f"[{self.source_id}] Row processing failed: {e}"
                        )
                        continue
                    if event is not None:
                        yield event
            finally:
                await browser.close()

    # ------------------------------------------------------------------
    # Listing
    # ------------------------------------------------------------------

    async def _fetch_listing(self, page: Page) -> list[dict]:
        listing = self.spec.listing
        # HTML listing URLs may still have {slug} placeholders.
        from webscraping.v2.scrapers.spec_driven import fill_template
        url = fill_template(listing.url_template, slug=self._slug)

        await page.goto(url, wait_until="domcontentloaded", timeout=_LOAD_TIMEOUT_MS)
        await page.wait_for_timeout(_SETTLE_MS)

        row_selector = listing.rows_path or "tr, .bid, .solicitation, article"
        elements = await page.query_selector_all(row_selector)
        if not elements:
            logger.warning(
                f"[{self.source_id}] HTML listing: rows_path={row_selector!r} "
                f"matched 0 elements on {page.url}"
            )
            return []

        results: list[dict] = []
        for el in elements:
            row_id = await self._extract_row_id(el, listing.row_id_field)
            if not row_id:
                continue
            title = ""
            if listing.row_title_field:
                title_el = await el.query_selector(listing.row_title_field)
                if title_el:
                    title = _collapse(await title_el.inner_text())
            if not title:
                title = _collapse(await el.inner_text())[:200]
            if not title:
                continue
            results.append({"id": row_id, "title": title, "_url": page.url})

        self.total_available = len(results)
        return results

    async def _extract_row_id(self, row_el, id_field: str) -> str:
        """`id_field` can be `attr_name`, `selector@attr`, or a CSS selector
        (in which case we take the matched element's text)."""
        if not id_field:
            return ""

        # `selector@attr` form
        m = _ATTR_REF_RE.match(id_field)
        if m:
            sub_sel, attr = m.group(1), m.group(2)
            sub = await row_el.query_selector(sub_sel)
            if sub is None:
                return ""
            val = await sub.get_attribute(attr)
            return (val or "").strip()

        # Plain attribute on the row element
        val = await row_el.get_attribute(id_field)
        if val is not None:
            return val.strip()

        # Fall back: treat as CSS selector + use text
        sub = await row_el.query_selector(id_field)
        if sub is not None:
            return _collapse(await sub.inner_text())[:120]

        return ""

    # ------------------------------------------------------------------
    # Detail (best-effort — many HTML specs only ship listing data)
    # ------------------------------------------------------------------

    async def _process_row(self, page: Page, row: dict) -> Optional[RawScrapedEvent]:
        listing = self.spec.listing
        row_id = row["id"]
        title = row["title"]

        description = ""
        attachment_urls: list[str] = []
        contact = ContactInfo()

        spec_detail = self.spec.detail
        if spec_detail and spec_detail.url_template:
            from webscraping.v2.scrapers.spec_driven import fill_template
            detail_url = fill_template(
                spec_detail.url_template, slug=self._slug, id=row_id
            )
            try:
                await page.goto(
                    detail_url, wait_until="domcontentloaded", timeout=_LOAD_TIMEOUT_MS
                )
                await page.wait_for_timeout(_SETTLE_MS)
            except Exception as e:
                logger.debug(
                    f"[{self.source_id}] Detail nav failed for {detail_url}: {e}"
                )
                detail_url = None

            if detail_url and spec_detail.summary_field:
                el = await page.query_selector(spec_detail.summary_field)
                if el:
                    description = _collapse(await el.inner_text())

            if detail_url and spec_detail.attachment_array_path:
                att_url_attr = spec_detail.attachment_url_field or "href"
                links = await page.query_selector_all(spec_detail.attachment_array_path)
                for link in links[:12]:
                    href = await link.get_attribute(att_url_attr)
                    abs_href = _absolutize(href or "", page.url)
                    if abs_href:
                        attachment_urls.append(abs_href)

        base = self._portal_url.rstrip("/")
        source_url = f"{base}/projects/{row_id}" if base else row.get("_url", "")

        return RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=row_id,
            source_url=source_url,
            title=title,
            description=description,
            issuing_agency=self._agency_name,
            contact=contact,
            attachment_urls=attachment_urls,
            raw_metadata={
                "spec_platform_class": self.spec.platform_class,
                "spec_confidence": self.spec.confidence,
                "spec_response_format": "html",
            },
        )
