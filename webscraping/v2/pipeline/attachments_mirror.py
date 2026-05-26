"""
Mirror RFP attachment PDFs to our S3 bucket.

Source portals (Cal eProcure, PlanetBids, OpenGov) hand out presigned
download URLs with short TTLs (Cal eProcure: 20 h). We scrape those URLs
into the manifest, but by the time a user clicks them in the dashboard
they're frequently 403/expired. Mirroring the bytes into our own bucket
under scrapes/v2/attachments/{event_id}/{filename} lets the dashboard
serve a stable URL through /api/attachments/ regardless of source-portal
URL rotation.

Best-effort: any S3 failure is logged and returns None so the rest of
the enrichment pipeline (text extraction, LLM call) continues. The
original URL is still emitted to the manifest as a fallback.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

from webscraping.v2.config import S3_BUCKET, get_s3_client

logger = logging.getLogger(__name__)

ATTACHMENTS_PREFIX = "scrapes/v2/attachments"

# S3 keys: keep filenames URL-safe so the front-end /api/attachments
# route can use them in a path segment without aggressive encoding.
_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(filename: str, fallback_index: int = 0) -> str:
    name = filename.strip() or f"attachment_{fallback_index}.pdf"
    name = _UNSAFE_CHARS.sub("_", name)
    if not name.lower().endswith(".pdf"):
        name = f"{name}.pdf"
    # Cap length so we don't pathologically blow out S3 key limits.
    return name[:160]


def mirror_pdf(
    event_id: str,
    filename: str,
    body: bytes,
    fallback_index: int = 0,
) -> Optional[str]:
    """Upload a PDF body to s3://{bucket}/scrapes/v2/attachments/{event_id}/{filename}.

    Returns the S3 key on success, None on any failure. Idempotent — re-runs
    overwrite the object, which is what we want when source filenames are
    stable across scrapes.
    """
    if not body:
        return None
    if not event_id:
        return None

    safe = _safe_filename(filename, fallback_index=fallback_index)
    key = f"{ATTACHMENTS_PREFIX}/{event_id}/{safe}"

    try:
        s3 = get_s3_client()
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=body,
            ContentType="application/pdf",
        )
        return key
    except Exception as e:
        logger.warning(
            "attachment mirror failed event=%s filename=%s err=%s",
            event_id, safe, e,
        )
        return None


def mirror_pdf_from_path(
    event_id: str,
    filename: str,
    file_path: str,
    fallback_index: int = 0,
) -> Optional[str]:
    """Convenience wrapper for callers that already wrote the PDF to disk."""
    try:
        with open(file_path, "rb") as f:
            body = f.read()
    except OSError as e:
        logger.warning("attachment mirror read-from-path failed: %s", e)
        return None
    return mirror_pdf(event_id, filename, body, fallback_index=fallback_index)
