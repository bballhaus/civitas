"""
PDF attachment extraction and LLM enrichment pipeline.

Downloads PDFs from attachment URLs, extracts text with pdfplumber,
sends to Groq for structured metadata extraction, and merges results.

Ported from the original extract_attachments.py with the same logic.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import time
from typing import Any, Optional

import pdfplumber
import requests
from groq import Groq

from webscraping.v2.config import GROQ_API_KEY, GROQ_MODEL, MAX_TEXT_CHARS, GROQ_SLEEP_SECONDS
from webscraping.v2.models import AttachmentExtraction, RawScrapedEvent

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# PDF priority classification
# ---------------------------------------------------------------------------

HIGH_PRIORITY = [
    r"Specification", r"Bid", r"Instr", r"SOW", r"Scope",
    r"RFP", r"RFQ", r"Solicitation", r"Statement.*Work",
]
MEDIUM_PRIORITY = [
    r"Addendum", r"Amendment", r"Agreement",
    r"Attachment", r"Exhibit", r"Contract",
]
SKIP_PATTERNS = [
    r"Drawing", r"Job.?Walk", r"Attendee", r"Sign.?In",
    r"Photo", r"Map", r"Floor.?Plan",
]


def classify_pdf(filename: str) -> str:
    name = filename.replace("_", " ")
    for pat in SKIP_PATTERNS:
        if re.search(pat, name, re.IGNORECASE):
            return "skip"
    for pat in HIGH_PRIORITY:
        if re.search(pat, name, re.IGNORECASE):
            return "high"
    for pat in MEDIUM_PRIORITY:
        if re.search(pat, name, re.IGNORECASE):
            return "medium"
    return "medium"


# ---------------------------------------------------------------------------
# LLM extraction prompt (same as original)
# ---------------------------------------------------------------------------

EXTRACTION_SCHEMA = {
    "naics_codes": ["string"],
    "certifications_required": ["string"],
    "clearances_required": ["string"],
    "set_aside_types": ["string"],
    "capabilities_required": ["string"],
    "contract_value_estimate": "string|null",
    "contract_duration": "string|null",
    "location_details": ["string"],
    "onsite_required": "boolean|null",
    "key_requirements_summary": "string (2-3 sentences)",
    "deliverables": ["string"],
    "evaluation_criteria": ["string"],
}

EXTRACTION_PROMPT = f"""You are analyzing a government RFP (Request for Proposal) or bid solicitation attachment document. Extract structured metadata from the document text below. Return valid JSON only — no markdown, no explanation.

Expected schema:
{json.dumps(EXTRACTION_SCHEMA, indent=2)}

Rules:
- naics_codes: NAICS codes mentioned (e.g. "561720", "236220"). Include the code numbers only.
- certifications_required: Required certifications (e.g. "Small Business (SB)", "DVBE", "DIR Registration")
- clearances_required: Security clearances needed (e.g. "Live Scan", "Background Check")
- set_aside_types: Set-aside categories (e.g. "Small Business", "DVBE", "8(a)")
- capabilities_required: Specific skills required (e.g. "HVAC maintenance", "software development")
- contract_value_estimate: Total estimated value as a string. Use null if not mentioned.
- contract_duration: Duration (e.g. "36 months", "3 years")
- location_details: Where work is performed (e.g. "Sacramento, CA")
- onsite_required: Whether physical onsite presence is required. null if unclear.
- key_requirements_summary: 2-3 sentence summary.
- deliverables: Specific deliverables or services.
- evaluation_criteria: How bids will be evaluated.

If a field is not mentioned, use [] for arrays, null for scalars, or "Unknown" for summary.

Document text:
---
{{text}}
---

Return ONLY the JSON object, no other text."""


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------

def extract_text_from_pdf(filepath: str) -> str:
    """Extract text from a PDF using pdfplumber."""
    parts = []
    try:
        with pdfplumber.open(filepath) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    parts.append(page_text)
    except Exception as e:
        raise RuntimeError(f"PDF text extraction failed: {e}") from e
    return "\n\n".join(parts).strip()


def download_pdf(url: str, cookies: dict | None = None) -> str:
    """Download a PDF from a URL to a temp file, return the path."""
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        resp = requests.get(url, cookies=cookies, stream=True, timeout=60)
        resp.raise_for_status()
        for chunk in resp.iter_content(chunk_size=8192):
            tmp.write(chunk)
        tmp.close()
        return tmp.name
    except Exception as e:
        os.unlink(tmp.name)
        raise RuntimeError(f"PDF download failed ({url}): {e}") from e


# ---------------------------------------------------------------------------
# Groq LLM call
# ---------------------------------------------------------------------------

def call_groq(text: str, max_retries: int = 5) -> dict[str, Any]:
    """Send text to Groq for structured extraction with rate-limit retry."""
    client = Groq(api_key=GROQ_API_KEY)
    prompt = EXTRACTION_PROMPT.replace("{text}", text)

    for attempt in range(max_retries):
        try:
            response = client.chat.completions.create(
                model=GROQ_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
            )
            raw = response.choices[0].message.content.strip()
            return _parse_llm_json(raw)
        except Exception as e:
            err = str(e)
            if "429" in err or "rate_limit" in err.lower():
                wait_match = re.search(r"try again in (\d+)m([\d.]+)s", err)
                if wait_match:
                    wait = int(wait_match.group(1)) * 60 + float(wait_match.group(2))
                else:
                    wait = min(30 * (2 ** attempt), 600)
                logger.warning(f"Rate limited, waiting {wait:.0f}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
            else:
                raise
    raise RuntimeError(f"Max retries ({max_retries}) exceeded for Groq API")


def _parse_llm_json(raw: str) -> dict[str, Any]:
    if raw.startswith("```"):
        lines = raw.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        raw = "\n".join(lines)
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Merge multiple extractions
# ---------------------------------------------------------------------------

LIST_FIELDS = [
    "naics_codes", "certifications_required", "clearances_required",
    "set_aside_types", "capabilities_required", "location_details",
    "deliverables", "evaluation_criteria",
]
SCALAR_FIELDS = [
    "contract_value_estimate", "contract_duration", "onsite_required",
    "key_requirements_summary",
]


def merge_extractions(extractions: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge multiple per-PDF extractions (union lists, first non-null scalars)."""
    if not extractions:
        return {}
    if len(extractions) == 1:
        return extractions[0]

    merged: dict[str, Any] = {}
    for field in LIST_FIELDS:
        combined = []
        seen: set[str] = set()
        for ext in extractions:
            for item in ext.get(field) or []:
                key = str(item).strip().lower()
                if key not in seen:
                    seen.add(key)
                    combined.append(item.strip() if isinstance(item, str) else item)
        merged[field] = combined

    for field in SCALAR_FIELDS:
        merged[field] = None
        for ext in extractions:
            val = ext.get(field)
            if val is not None and val != "Unknown" and val != "":
                merged[field] = val
                break

    return merged


# ---------------------------------------------------------------------------
# Main enrichment function
# ---------------------------------------------------------------------------

def enrich_event(
    event: RawScrapedEvent,
    cookies: dict | None = None,
) -> Optional[AttachmentExtraction]:
    """
    LLM-process attachments for an event.

    If the scraper already downloaded and extracted text (stored in
    raw_metadata["attachment_texts"]), use that directly. Otherwise,
    fall back to downloading PDFs via requests (works for public URLs only).

    Returns AttachmentExtraction or None if no text could be extracted.
    """
    pre_extracted = event.raw_metadata.get("attachment_texts", {})
    has_pre_extracted = any(text for text in pre_extracted.values() if text)

    if not has_pre_extracted and not event.attachment_urls:
        return None

    # Classify and sort by priority
    attachments = []

    if has_pre_extracted:
        # Use text already extracted during scraping (session-bound downloads)
        for filename, text in pre_extracted.items():
            if not text:
                continue
            priority = classify_pdf(filename)
            if priority != "skip":
                attachments.append((filename, text, priority))
    else:
        # Fall back to downloading via requests (public URLs only)
        for url in event.attachment_urls:
            filename = url.split("/")[-1].split("?")[0] or "unknown.pdf"
            priority = classify_pdf(filename)
            if priority != "skip":
                attachments.append((url, filename, priority))

    # Sort: high priority first
    order = {"high": 0, "medium": 1}
    attachments.sort(key=lambda x: order.get(x[2], 1))

    if not attachments:
        return None

    extractions = []
    all_text_parts = []

    for item in attachments:
        if has_pre_extracted:
            # Pre-extracted text: item = (filename, text, priority)
            filename, text, priority = item
            try:
                if len(text) > MAX_TEXT_CHARS:
                    text = text[:MAX_TEXT_CHARS] + "\n\n[... document truncated ...]"

                logger.info(f"  {filename}: {len(text)} chars (pre-extracted)")
                all_text_parts.append(f"=== {filename} ===\n{text}")

                result = call_groq(text)
                extractions.append(result)
                time.sleep(GROQ_SLEEP_SECONDS)
            except Exception as e:
                logger.warning(f"Failed LLM processing {filename}: {e}")
        else:
            # Download via requests: item = (url, filename, priority)
            url, filename, priority = item
            tmp_path = None
            try:
                tmp_path = download_pdf(url, cookies=cookies)
                text = extract_text_from_pdf(tmp_path)
                if not text:
                    logger.debug(f"No text from {filename}")
                    continue

                if len(text) > MAX_TEXT_CHARS:
                    text = text[:MAX_TEXT_CHARS] + "\n\n[... document truncated ...]"

                logger.info(f"  {filename}: {len(text)} chars")
                all_text_parts.append(f"=== {filename} ===\n{text}")

                result = call_groq(text)
                extractions.append(result)
                time.sleep(GROQ_SLEEP_SECONDS)

            except Exception as e:
                logger.warning(f"Failed processing {filename}: {e}")
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    os.unlink(tmp_path)

    if not extractions:
        return None

    merged = merge_extractions(extractions)

    # Build text rollup
    full_text = "\n\n".join(all_text_parts)
    rollup = full_text[:5000] + "\n\n[... truncated ...]" if len(full_text) > 5000 else full_text

    return AttachmentExtraction(
        naics_codes=merged.get("naics_codes", []),
        certifications_required=merged.get("certifications_required", []),
        clearances_required=merged.get("clearances_required", []),
        set_aside_types=merged.get("set_aside_types", []),
        capabilities_required=merged.get("capabilities_required", []),
        contract_value_estimate=merged.get("contract_value_estimate"),
        contract_duration=merged.get("contract_duration"),
        location_details=merged.get("location_details", []),
        onsite_required=merged.get("onsite_required"),
        key_requirements_summary=merged.get("key_requirements_summary", "Unknown"),
        deliverables=merged.get("deliverables", []),
        evaluation_criteria=merged.get("evaluation_criteria", []),
        attachment_text_rollup=rollup,
        pdfs_processed=[f for _, f, _ in attachments],
        total_pdfs_available=len(event.attachment_urls),
    )
