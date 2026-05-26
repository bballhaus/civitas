"""
Spec-driven scraper — runtime scraper parameterised by an InvestigationSpec.

The companion to `webscraping/v2/agents/site_investigation.py`. The
investigation agent produces an `InvestigationSpec` JSON describing a
portal's listing + detail endpoints; this class executes the spec at
scrape time.

Why this exists: it closes the loop on the onboarding pipeline. A new
procurement platform comes online by writing a spec into S3, no code
deploy — same dynamic-registry pattern as OpenGov, but platform-agnostic.

Goal hierarchy mirrors the agent's: clean REST JSON API today, with
rendered-HTML support left as a deliberate TODO. JSON-API specs are
where the agent reports `confidence: high`; HTML specs are the
fall-back path and warrant their own scraper class.

S3 layout used by the onboarding flow:
  scrapes/v2/spec_sites/{site_id}.json
      {
        "site_id": "...",
        "slug": "long-beach",
        "name": "City of Long Beach",
        "url": "https://procurement.opengov.com/portal/long-beach",
        "spec": { <InvestigationSpec> }
      }
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
from typing import Any, AsyncIterator, Optional

import requests

from webscraping.v2.agents.site_investigation import InvestigationSpec
from webscraping.v2.models import ContactInfo, RawScrapedEvent, SiteConfig
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)


_DEFAULT_TIMEOUT = 30
_DEFAULT_BATCH_SIZE = 12
_MAX_PDFS_PER_EVENT = 12

# Browser-like UA so unauth REST APIs that gate on User-Agent (OpenGov,
# many others) don't 403 the default `python-requests/X.Y.Z` string.
# The agent's spec may also include headers_required; those merge on top.
_BASELINE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def fill_template(template: str, **values: Any) -> str:
    """Substitute `{name}` occurrences from `values`; leave unknowns intact.

    Regex-based (not `str.format`) on purpose: spec body templates are
    typically JSON like `'{"status":"open","page":{page}}'`, and the
    real JSON braces would collide with `.format()` syntax.
    """
    def repl(match: re.Match) -> str:
        name = match.group(1)
        if name in values and values[name] is not None:
            return str(values[name])
        return match.group(0)
    return _PLACEHOLDER_RE.sub(repl, template)


def traverse(data: Any, path: str) -> Any:
    """Dotted-path traversal through dicts (and numeric-indexed lists).

    Empty path returns the root. Returns None on any failure rather
    than raising, so callers can decide whether a missing path is
    fatal.
    """
    if not path:
        return data
    cur: Any = data
    for part in path.split("."):
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return cur


def strip_html(html: str) -> str:
    """Bare HTML→text. Tag-strip + whitespace collapse.

    The enrichment pipeline does heavier text cleanup downstream;
    keep this minimal so we don't accidentally swallow real content.
    """
    if not html:
        return ""
    return _WHITESPACE_RE.sub(" ", _HTML_TAG_RE.sub("", html)).strip()


class SpecDrivenScraper(BaseScraper):
    """Executes an InvestigationSpec produced by the site-investigation agent.

    `site_config.config` must contain:
        spec    — the InvestigationSpec dict (validated on init)
        slug    — per-portal URL identifier (substituted into {slug})
        name    — agency display name
        url     — portal landing URL (used to build per-bid source_url)
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
                f"SpecDrivenScraper requires site_config.config['spec'] "
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
        listing = self.spec.listing
        if listing.response_format == "html":
            # Delegate to the HTML scraper. Lazy import keeps the
            # Playwright dependency optional for callers that only
            # ever see JSON specs.
            from webscraping.v2.scrapers.spec_html import HtmlSpecScraper
            html_scraper = HtmlSpecScraper(
                self.site_config,
                batch_offset=self.batch_offset,
                batch_size=self.batch_size,
            )
            async for event in html_scraper.scrape():
                self.total_available = html_scraper.total_available
                yield event
            return
        if listing.response_format != "json":
            raise NotImplementedError(
                f"SpecDrivenScraper supports response_format=json|html; "
                f"got {listing.response_format!r} for {self.source_id}."
            )

        try:
            rows = await asyncio.to_thread(self._fetch_listing)
        except Exception as e:
            logger.error(f"[{self.source_id}] Listing fetch failed: {e}")
            return

        logger.info(
            f"[{self.source_id}] Listing returned {len(rows)} rows "
            f"(total {self.total_available}); platform={self.spec.platform_class}, "
            f"confidence={self.spec.confidence}"
        )

        for row in rows:
            try:
                event = await self._process_row(row)
            except Exception as e:
                logger.warning(
                    f"[{self.source_id}] Row processing failed: {e}"
                )
                continue
            if event is not None:
                yield event

    # ------------------------------------------------------------------
    # Listing
    # ------------------------------------------------------------------

    def _fetch_listing(self) -> list[dict]:
        listing = self.spec.listing
        page = self.batch_offset // self.batch_size + 1 if self.batch_size else 1
        limit = self.batch_size

        url = fill_template(
            listing.url_template,
            slug=self._slug,
            page=page,
            limit=limit,
        )

        body: Any = None
        if listing.body_template:
            body_str = fill_template(
                listing.body_template,
                slug=self._slug,
                page=page,
                limit=limit,
            )
            try:
                body = json.loads(body_str)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"Listing body_template did not parse as JSON after "
                    f"substitution for {self.source_id}: {e}"
                )

        data = self._http(listing.method, url, body, listing.headers_required)

        rows = traverse(data, listing.rows_path)
        if rows is None and not listing.rows_path:
            # Whole response IS the array
            rows = data
        if not isinstance(rows, list):
            logger.warning(
                f"[{self.source_id}] rows_path={listing.rows_path!r} did not "
                f"resolve to a list (got {type(rows).__name__}); "
                f"top-level keys: {list(data.keys()) if isinstance(data, dict) else 'n/a'}"
            )
            return []

        # Best-effort total. The spec doesn't model where the total lives,
        # but `count` (OpenGov), `total`, `totalCount`, and `total_count`
        # cover the common shapes. Falls back to len(rows) when absent.
        if isinstance(data, dict):
            for k in ("count", "total", "totalCount", "total_count"):
                if k in data:
                    try:
                        self.total_available = int(data[k] or 0)
                        break
                    except (TypeError, ValueError):
                        continue
            else:
                self.total_available = len(rows)
        else:
            self.total_available = len(rows)

        return rows

    # ------------------------------------------------------------------
    # Detail + event build
    # ------------------------------------------------------------------

    async def _process_row(self, row: dict) -> Optional[RawScrapedEvent]:
        listing = self.spec.listing
        id_field = listing.row_id_field
        title_field = listing.row_title_field

        row_id_raw = row.get(id_field) if id_field else None
        row_id = str(row_id_raw).strip() if row_id_raw is not None else ""
        if not row_id:
            logger.debug(
                f"[{self.source_id}] Row missing id field {id_field!r}; skipping"
            )
            return None

        title = ""
        if title_field:
            title = str(row.get(title_field) or "").strip()
        if not title:
            return None

        detail: Optional[dict] = None
        if self.spec.detail:
            try:
                self.throttle()
                detail = await asyncio.to_thread(self._fetch_detail, row_id)
            except Exception as e:
                logger.warning(
                    f"[{self.source_id}] Detail fetch failed for {row_id}: {e}"
                )

        event = self._build_event(row, row_id, title, detail)

        if detail is not None and self.spec.detail and self.spec.detail.attachment_array_path:
            try:
                await asyncio.to_thread(self._download_attachments, event, detail)
            except Exception as e:
                # Attachments are best-effort — keep the event, let
                # enrichment do what it can with whatever we got.
                logger.warning(
                    f"[{self.source_id}] Attachment pass failed for "
                    f"{row_id}: {e}"
                )

        return event

    def _fetch_detail(self, row_id: str) -> Any:
        detail = self.spec.detail
        if detail is None:
            return None
        url = fill_template(detail.url_template, slug=self._slug, id=row_id)
        body: Any = None
        if detail.body_template:
            body_str = fill_template(detail.body_template, slug=self._slug, id=row_id)
            try:
                body = json.loads(body_str)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"Detail body_template did not parse as JSON after "
                    f"substitution for {self.source_id}: {e}"
                )
        return self._http(detail.method, url, body, detail.headers_required)

    def _build_event(
        self,
        row: dict,
        row_id: str,
        title: str,
        detail: Optional[dict],
    ) -> RawScrapedEvent:
        detail = detail or {}
        spec_detail = self.spec.detail

        description = ""
        contact = ContactInfo()

        if spec_detail and spec_detail.summary_field:
            summary_raw = detail.get(spec_detail.summary_field) or row.get(spec_detail.summary_field) or ""
            description = strip_html(str(summary_raw))

        if spec_detail:
            email = detail.get(spec_detail.contact_email_field) if spec_detail.contact_email_field else None
            name = detail.get(spec_detail.contact_name_field) if spec_detail.contact_name_field else None
            phone = detail.get(spec_detail.contact_phone_field) if spec_detail.contact_phone_field else None
            if any([email, name, phone]):
                contact = ContactInfo(
                    name=str(name).strip() if name else None,
                    email=str(email).strip() if email else None,
                    phone=str(phone).strip() if phone else None,
                )

        # Per-bid source_url: most platforms expose a clean public
        # permalink at `{portal}/projects/{id}` (OpenGov pattern). When
        # the convention doesn't hold, the spec can extend its model
        # with a bid_url_template field — for now this default covers
        # every platform we've seen.
        base = self._portal_url.rstrip("/")
        source_url = f"{base}/projects/{row_id}" if base else ""

        return RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=row_id,
            source_url=source_url,
            title=title,
            description=description,
            issuing_agency=self._agency_name,
            contact=contact,
            raw_metadata={
                "spec_platform_class": self.spec.platform_class,
                "spec_confidence": self.spec.confidence,
                "row_keys": list(row.keys())[:20],
            },
        )

    # ------------------------------------------------------------------
    # Attachments — mirror OpenGov: download, extract text, stash on event
    # ------------------------------------------------------------------

    def _download_attachments(self, event: RawScrapedEvent, detail: dict) -> None:
        spec_detail = self.spec.detail
        if spec_detail is None or not spec_detail.attachment_array_path:
            return

        from webscraping.v2.pipeline.attachments_mirror import mirror_pdf
        from webscraping.v2.pipeline.enrich import (
            classify_pdf,
            extract_text_from_pdf,
        )
        from webscraping.v2.utils import make_event_id

        atts = traverse(detail, spec_detail.attachment_array_path)
        if not isinstance(atts, list) or not atts:
            return

        url_field = spec_detail.attachment_url_field or "url"
        name_field = spec_detail.attachment_filename_field or "filename"

        event_id = make_event_id(event.source_id, event.source_event_id)
        attachment_texts: dict[str, str] = {}
        mirror_sink = event.raw_metadata.setdefault("mirrored_attachments", [])
        headers = dict(_BASELINE_HEADERS)

        for idx, att in enumerate(atts[:_MAX_PDFS_PER_EVENT]):
            if not isinstance(att, dict):
                continue
            url = str(att.get(url_field) or "").strip()
            if not url:
                continue
            filename = str(att.get(name_field) or "document.pdf").strip()
            if not filename.lower().endswith(".pdf"):
                # Non-PDFs (Excel, Word, Zip) — enrichment only handles
                # PDFs. Skip rather than misnaming.
                continue
            if classify_pdf(filename) == "skip":
                continue

            tmp_path: Optional[str] = None
            try:
                resp = requests.get(url, headers=headers, timeout=_DEFAULT_TIMEOUT)
                if not resp.ok or not resp.content or len(resp.content) < 100:
                    continue
                with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                    tmp.write(resp.content)
                    tmp_path = tmp.name
                text = extract_text_from_pdf(tmp_path)
                if text:
                    attachment_texts[filename] = text
                    if url not in event.attachment_urls:
                        event.attachment_urls.append(url)
                    logger.info(
                        f"[{self.source_id}]   PDF: {filename} "
                        f"({len(text)} chars)"
                    )
                s3_key = mirror_pdf(event_id, filename, resp.content, fallback_index=idx)
                if s3_key:
                    mirror_sink.append({
                        "filename": filename,
                        "s3_key": s3_key,
                        "original_url": url,
                    })
            except Exception as e:
                logger.debug(
                    f"[{self.source_id}]   PDF fetch failed {filename}: {e}"
                )
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

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------

    def _http(
        self,
        method: str,
        url: str,
        body: Any,
        spec_headers: dict[str, str],
    ) -> Any:
        headers = dict(_BASELINE_HEADERS)
        headers.update(spec_headers or {})

        method = (method or "GET").upper()
        if method == "GET":
            resp = requests.get(url, headers=headers, timeout=_DEFAULT_TIMEOUT)
        elif method == "POST":
            resp = requests.post(
                url, json=body, headers=headers, timeout=_DEFAULT_TIMEOUT
            )
        else:
            raise ValueError(
                f"Unsupported HTTP method {method!r} in spec for {self.source_id}"
            )
        resp.raise_for_status()
        return resp.json()


# ---------------------------------------------------------------------------
# Dynamic registry: load specs from S3 so onboarding is no-code-deploy
# ---------------------------------------------------------------------------

_S3_SPEC_PREFIX = "scrapes/v2/spec_sites/"


def _load_spec_site_configs_from_s3() -> dict[str, SiteConfig]:
    """List spec_sites/*.json in the bucket and build SiteConfig entries.

    Each object is a self-contained portal definition (slug + name + url
    + spec). Adding a new platform never requires touching this code:
    write the JSON, the next runner pickup includes it.
    """
    try:
        from webscraping.v2.config import S3_BUCKET, get_s3_client
        from webscraping.v2.models import ScraperType
    except Exception:
        return {}

    configs: dict[str, SiteConfig] = {}
    try:
        s3 = get_s3_client()
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=_S3_SPEC_PREFIX):
            for obj in page.get("Contents") or []:
                key = obj["Key"]
                if not key.endswith(".json"):
                    continue
                try:
                    body = s3.get_object(Bucket=S3_BUCKET, Key=key)["Body"].read()
                    entry = json.loads(body)
                except Exception as e:
                    logger.warning(f"spec_sites: failed to load {key}: {e}")
                    continue
                site_id = entry.get("site_id") or key.rsplit("/", 1)[-1][:-5]
                spec = entry.get("spec")
                if not isinstance(spec, dict):
                    logger.warning(
                        f"spec_sites: {key} missing 'spec' object; skipping"
                    )
                    continue
                configs[site_id] = SiteConfig(
                    site_id=site_id,
                    name=entry.get("name", site_id),
                    url=entry.get("url", ""),
                    scraper_type=ScraperType.SPEC_DRIVEN,
                    min_request_interval_ms=3000,
                    config={
                        "slug": entry.get("slug", ""),
                        "name": entry.get("name", site_id),
                        "url": entry.get("url", ""),
                        "spec": spec,
                    },
                )
    except Exception as e:
        logger.warning(f"spec_sites: registry load failed: {e}")

    return configs


def get_spec_driven_site_configs() -> dict[str, SiteConfig]:
    """Public entry — used by the runner registry builder."""
    return _load_spec_site_configs_from_s3()
