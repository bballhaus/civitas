"""
OpenGov Procurement scraper — multi-tenant Tier-2 structured scraper.

OpenGov Procurement (formerly ProcureNow) is a SaaS platform many CA
cities have migrated onto. Each agency lives at
`https://procurement.opengov.com/portal/{slug}` with a near-identical
DOM, so a single scraper covers many agencies.

Sites are added by appending an entry to OPENGOV_AGENCIES; the runner
picks them up automatically through `get_opengov_site_configs`.

## Direct JSON API — no Cloudflare

The customer-facing portal at `procurement.opengov.com` is fronted by
Cloudflare bot detection, but OpenGov's JSON API host
`api.procurement.opengov.com` is wide open: no challenge, no auth, no
rate-limit headers in normal use. We hit the API directly with
`requests` and skip ScrapingBee entirely. The investigation that
arrived at this is documented in the README.

Two endpoints are used:

  * `POST /api/v1/government/{slug}/project/public`
        body: `{"status": "open", "page": N, "limit": L}`
        → `{"count": int, "rows": [Project, ...]}`

  * `GET  /api/v1/project/{id}`
        → full Project (149 keys; includes `summary`, `attachments[]`,
        contact fields).

PDF attachments are public URLs on `s3.amazonaws.com` (or similar);
they don't require any cookie or token, so we just `requests.get`
each one and feed the bytes to the existing PyMuPDF + Claude Haiku
enrichment pipeline.

If `api.procurement.opengov.com` ever gets put behind Cloudflare, the
fallback is `config.fetch_via_scrapingbee` against the same URL —
ScrapingBee will render and return the JSON body as text. That fallback
is not currently wired up because the API is direct today.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile
from typing import AsyncIterator, Optional

import requests

from webscraping.v2.models import ContactInfo, RawScrapedEvent, SiteConfig
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)


OPENGOV_API_BASE = "https://api.procurement.opengov.com/api/v1"


# Cloudflare in front of api.procurement.opengov.com 403s the default
# `python-requests/X.Y.Z` User-Agent. A browser-like UA is enough — we
# tested empty Origin/Referer and got 200, so only UA matters.
_DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


# CA agencies on OpenGov Procurement. Slug = the URL segment after /portal/.
# Add new entries as the discovery agent finds them.
OPENGOV_AGENCIES: dict[str, dict] = {
    "opengov_pasadena": {
        "slug": "pasadena",
        "name": "City of Pasadena",
        "url": "https://procurement.opengov.com/portal/pasadena",
    },
}


# How many bid detail pages to fetch per Lambda invocation. Each detail
# fetch may pull a dozen+ PDFs, so this is the cost-bottleneck knob.
DEFAULT_BATCH_SIZE = 12

MAX_PDFS_PER_EVENT = 12  # Defensive cap on attachments.

DEFAULT_TIMEOUT = 30  # Seconds for individual API + PDF requests.

# Status filter for the listing API. "open" gives currently-active bids;
# the API also supports "closed" / "awarded" / etc. for historical data
# that we don't currently consume.
DEFAULT_STATUS = "open"


class OpenGovScraper(BaseScraper):
    """Multi-tenant OpenGov Procurement scraper (direct JSON API)."""

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
        self._status: str = cfg.get("status", DEFAULT_STATUS)
        self.batch_offset = batch_offset
        self.batch_size = batch_size or DEFAULT_BATCH_SIZE
        self.total_available: int = 0

    # ------------------------------------------------------------------
    # Top-level orchestration
    # ------------------------------------------------------------------

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        try:
            rows = await asyncio.to_thread(self._list_projects)
        except Exception as e:
            logger.error(f"[{self.source_id}] Listing fetch failed: {e}")
            return

        logger.info(
            f"[{self.source_id}] Listing returned {len(rows)} rows "
            f"(total {self.total_available}); fetching detail for each"
        )

        for row in rows:
            project_id = row.get("id")
            if not project_id:
                continue
            try:
                self.throttle()
                detail = await asyncio.to_thread(self._fetch_detail, project_id)
            except Exception as e:
                logger.warning(
                    f"[{self.source_id}] Detail fetch failed for "
                    f"{project_id}: {e}"
                )
                continue

            event = self._build_event(detail, row)
            if event is None:
                continue
            try:
                await asyncio.to_thread(self._download_attachments, event, detail)
            except Exception as e:
                # Attachments are best-effort — yield the event with whatever
                # we got and let downstream enrichment do what it can.
                logger.warning(
                    f"[{self.source_id}] Attachment pass failed for "
                    f"{project_id}: {e}"
                )
            logger.info(
                f"[{self.source_id}] Scraped: "
                f"{(event.title or '')[:60]} "
                f"({len(event.attachment_urls)} PDFs)"
            )
            yield event

    # ------------------------------------------------------------------
    # API client
    # ------------------------------------------------------------------

    def _list_projects(self) -> list[dict]:
        """POST the listing endpoint and return the slice we need.

        Pagination contract: the orchestrator chains batches by passing
        `batch_offset += batch_size` on each invocation, so batch_offset
        is always a multiple of batch_size in practice. We map that to
        the API's 1-indexed `page` and use `batch_size` as `limit`. If
        an offline caller passes a non-multiple offset we fall back to
        fetching the prefix and slicing.
        """
        body = {"status": self._status}
        if self.batch_size > 0 and self.batch_offset % self.batch_size == 0:
            body["page"] = self.batch_offset // self.batch_size + 1
            body["limit"] = self.batch_size
            slice_locally = False
        else:
            body["page"] = 1
            body["limit"] = self.batch_offset + self.batch_size
            slice_locally = True

        url = f"{OPENGOV_API_BASE}/government/{self._slug}/project/public"
        resp = requests.post(
            url, json=body, headers=_DEFAULT_HEADERS, timeout=DEFAULT_TIMEOUT
        )
        resp.raise_for_status()
        data = resp.json()

        self.total_available = int(data.get("count", 0))
        rows = data.get("rows") or []
        if slice_locally:
            rows = rows[self.batch_offset:self.batch_offset + self.batch_size]
        return rows

    def _fetch_detail(self, project_id: int) -> dict:
        url = f"{OPENGOV_API_BASE}/project/{project_id}"
        resp = requests.get(
            url, headers=_DEFAULT_HEADERS, timeout=DEFAULT_TIMEOUT
        )
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Pure builders (unit-testable without network)
    # ------------------------------------------------------------------

    def _build_event(
        self, detail: dict, listing_row: dict
    ) -> Optional[RawScrapedEvent]:
        project_id = detail.get("id") or listing_row.get("id")
        if not project_id:
            return None

        title = (detail.get("title") or listing_row.get("title") or "").strip()
        if not title:
            return None

        financial_id = (
            detail.get("financialId") or listing_row.get("financialId") or ""
        ).strip()
        source_event_id = financial_id or str(project_id)
        source_url = f"{self._portal_url.rstrip('/')}/projects/{project_id}"

        # Description: prefer detail's `summary` (full HTML); fall back to
        # listing's. Strip HTML tags inline — we keep it simple here; the
        # enrichment pipeline does heavier text cleanup downstream.
        summary_html = detail.get("summary") or listing_row.get("summary") or ""
        description = _strip_html(summary_html)

        # `government.organization` is a nested object containing the
        # full agency profile (logo, address, name, etc.), not a plain
        # string. Pull `name` and fall back to the SiteConfig label.
        agency = self._agency_name
        government = detail.get("government") or {}
        org = government.get("organization")
        if isinstance(org, dict) and org.get("name"):
            agency = org["name"]

        return RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=source_event_id,
            source_url=source_url,
            title=title,
            description=description,
            issuing_agency=agency,
            posted_date=detail.get("releaseProjectDate") or "",
            due_date=detail.get("proposalDeadline") or "",
            contact=_extract_contact(detail),
            procurement_type=_extract_procurement_type(financial_id),
            raw_metadata={
                "project_id": project_id,
                "financial_id": financial_id,
                "status": detail.get("status") or listing_row.get("status") or "",
                "department": (detail.get("department") or {}).get("name") or "",
            },
        )

    # ------------------------------------------------------------------
    # PDF attachment download
    # ------------------------------------------------------------------

    def _download_attachments(self, event: RawScrapedEvent, detail: dict) -> None:
        """Fetch attachment PDFs and stash extracted text on the event.

        Mirrors the Cal eProcure path: download bytes, run PyMuPDF on a
        temp file, populate `event.attachment_urls` and
        `event.raw_metadata['attachment_texts']` so downstream enrichment
        sees them in the shape it already expects.
        """
        from webscraping.v2.pipeline.enrich import (
            classify_pdf,
            extract_text_from_pdf,
        )

        attachments = detail.get("attachments") or []
        if not attachments:
            return

        attachment_texts: dict[str, str] = {}
        for att in attachments[:MAX_PDFS_PER_EVENT]:
            url = (att.get("url") or "").strip()
            if not url:
                continue
            filename = (
                att.get("filename")
                or att.get("name")
                or att.get("title")
                or "document.pdf"
            )
            if not filename.lower().endswith(".pdf"):
                # OpenGov hosts non-PDF attachments too (Excel, Word, etc.).
                # Skip them — the LLM enrichment pipeline only handles PDFs.
                ext = (att.get("fileExtension") or "").lower()
                if ext != ".pdf":
                    continue
                filename = f"{filename}.pdf"
            if classify_pdf(filename) == "skip":
                continue

            tmp_path: Optional[str] = None
            try:
                resp = requests.get(
                    url, headers=_DEFAULT_HEADERS, timeout=DEFAULT_TIMEOUT
                )
                if not resp.ok:
                    continue
                body = resp.content
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
                    logger.info(f"  PDF: {filename} ({len(text)} chars)")
            except Exception as e:
                logger.debug(f"  PDF fetch failed {filename}: {e}")
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass

        if attachment_texts:
            existing = event.raw_metadata.get("attachment_texts") or {}
            existing.update(attachment_texts)
            event.raw_metadata["attachment_texts"] = existing


# ---------------------------------------------------------------------------
# Pure helpers — exposed for unit testing
# ---------------------------------------------------------------------------

# Match the procurement-type token in a financialId like "2026-RFP-0123",
# "RFB-2026-007", or "2026-IFB-CIV-0216". The token is the first letter
# group between hyphens that isn't a 4-digit year.
_PROC_TYPE_RE = re.compile(r"\b(RFP|RFQ|RFI|IFB|RFB|IFQ|RFO)\b", re.IGNORECASE)


def _extract_procurement_type(financial_id: str) -> str:
    if not financial_id:
        return "RFP"
    m = _PROC_TYPE_RE.search(financial_id)
    return m.group(1).upper() if m else "RFP"


def _extract_contact(detail: dict) -> ContactInfo:
    """Map OpenGov's flat contact* fields onto our ContactInfo shape.

    OpenGov exposes both a project-contact set (`contact*`) and a
    procurement-officer set (`procurement*`). We prefer the project
    contact since that's who the bidder is supposed to reach.
    """
    name = (
        (detail.get("contactDisplayName")
         or detail.get("contactFullName")
         or "").strip()
    )
    if not name:
        first = (detail.get("contactFirstName") or "").strip()
        last = (detail.get("contactLastName") or "").strip()
        name = (first + " " + last).strip()

    email = (detail.get("contactEmail") or "").strip()
    phone = (
        (detail.get("contactPhoneComplete")
         or detail.get("contactPhone")
         or "").strip()
    )
    return ContactInfo(
        name=name or None,
        email=email or None,
        phone=phone or None,
    )


_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def _strip_html(html: str) -> str:
    if not html:
        return ""
    text = _TAG_RE.sub(" ", html)
    # Decode the handful of entities OpenGov actually emits.
    text = (
        text.replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
            .replace("&#39;", "'")
    )
    return _WHITESPACE_RE.sub(" ", text).strip()


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
            min_request_interval_ms=2000,
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
        print(f"    bid={e.raw_metadata.get('financial_id')!r}  "
              f"PDFs={len(e.attachment_urls)}  "
              f"contact={e.contact.email!r}")


if __name__ == "__main__":
    asyncio.run(main())
