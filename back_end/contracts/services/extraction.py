"""
Contract metadata extraction service.

Extracts text from uploaded documents (PDF) and uses an LLM to parse
structured metadata. Uses Groq by default (free tier, fast inference).
"""

import json
import logging
import os
from typing import Any

from django.conf import settings

logger = logging.getLogger(__name__)


class ExtractionError(Exception):
    """Raised when document text extraction or LLM parsing fails."""

    pass


# Expected output schema for LLM
EXTRACTION_SCHEMA = {
    "issuing_agency": "string",
    "title": "string|null",
    "jurisdiction": {
        "state": "CA",
        "county": "string|null",
        "city": "string|null",
    },
    "features": {
        "required_certifications": ["string"],
        "required_clearances": ["string"],
        "onsite_required": "boolean|null",
        "work_locations": ["string"],
        "naics_codes": ["string"],
        "industry_tags": ["string"],
        "min_past_performance": "string|null",
        "contract_value_estimate": "string|null",
        "timeline_duration": "string|null",
    },
}

EXTRACTION_PROMPT = f"""Extract metadata from this government/contract document. Return valid JSON only, no markdown or explanation.

Expected schema:
{json.dumps(EXTRACTION_SCHEMA, indent=2)}

Rules:
- issuing_agency: the government agency or entity issuing the contract (required)
- title: contract title if evident, else null
- jurisdiction: state (default CA), county, city - use null if not specified
- features: extract arrays as lists; use null for unknown booleans/strings
- contract_value_estimate: dollar amount as string (e.g. "500000" or "$500,000")
- naics_codes: North American Industry Classification codes if mentioned
- industry_tags: relevant sectors (e.g. IT, construction, healthcare)

Document text:
---
{{text}}
---

Return ONLY the JSON object, no other text."""


def _extract_text_from_pdf(file) -> str:
    """Extract text from a PDF file."""
    import pdfplumber

    text_parts = []
    try:
        with pdfplumber.open(file) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
    except Exception as e:
        raise ExtractionError(f"Failed to extract text from PDF: {e}") from e

    text = "\n\n".join(text_parts).strip()
    if not text:
        raise ExtractionError("No text could be extracted from the PDF")
    return text


def _extract_text(file) -> str:
    """Extract text from an uploaded file. Supports PDF."""
    name = getattr(file, "name", "") or ""
    if name.lower().endswith(".pdf"):
        return _extract_text_from_pdf(file)
    raise ExtractionError(f"Unsupported file type. Supported: PDF. Got: {name}")


def _call_groq(text: str) -> dict[str, Any]:
    """Call Groq API (cheap/free tier, fast inference)."""
    try:
        from groq import Groq
    except ImportError:
        raise ExtractionError(
            "Groq SDK not installed. Run: pip install groq"
        ) from None

    api_key = (
        getattr(settings, "GROQ_API_KEY", None)
        or getattr(settings, "EXTRACTION_API_KEY", None)
        or os.environ.get("GROQ_API_KEY")
    )
    if not api_key:
        raise ExtractionError(
            "GROQ_API_KEY or EXTRACTION_API_KEY not set in settings or environment"
        )

    client = Groq(api_key=api_key)
    model = getattr(settings, "EXTRACTION_LLM_MODEL", "llama-3.1-8b-instant")

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": EXTRACTION_PROMPT.format(text=text)}],
        temperature=0.1,
    )
    raw = response.choices[0].message.content.strip()
    return _parse_llm_json(raw)


def _call_openai(text: str) -> dict[str, Any]:
    """Call OpenAI API (GPT-4o-mini is cheap)."""
    try:
        from openai import OpenAI
    except ImportError:
        raise ExtractionError(
            "OpenAI SDK not installed. Run: pip install openai"
        ) from None

    api_key = getattr(settings, "OPENAI_API_KEY", None) or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ExtractionError("OPENAI_API_KEY not set in settings or environment")

    client = OpenAI(api_key=api_key)
    model = getattr(settings, "EXTRACTION_LLM_MODEL", "gpt-4o-mini")

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": EXTRACTION_PROMPT.format(text=text)}],
        temperature=0.1,
    )
    raw = response.choices[0].message.content.strip()
    return _parse_llm_json(raw)


def _parse_llm_json(raw: str) -> dict[str, Any]:
    """Parse JSON from LLM response, handling markdown code blocks."""
    # Remove markdown code fences if present
    if raw.startswith("```"):
        lines = raw.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        raw = "\n".join(lines)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ExtractionError(f"LLM returned invalid JSON: {e}") from e


def _normalize_result(data: dict[str, Any]) -> dict[str, Any]:
    """Ensure result matches expected structure with safe defaults."""
    jurisdiction = data.get("jurisdiction") or {}
    features = data.get("features") or {}
    return {
        "issuing_agency": data.get("issuing_agency") or "Unknown",
        "title": data.get("title"),
        "jurisdiction": {
            "state": jurisdiction.get("state") or "CA",
            "county": jurisdiction.get("county"),
            "city": jurisdiction.get("city"),
        },
        "features": {
            "required_certifications": features.get("required_certifications") or [],
            "required_clearances": features.get("required_clearances") or [],
            "onsite_required": features.get("onsite_required"),
            "work_locations": features.get("work_locations") or [],
            "naics_codes": features.get("naics_codes") or [],
            "industry_tags": features.get("industry_tags") or [],
            "min_past_performance": features.get("min_past_performance"),
            "contract_value_estimate": features.get("contract_value_estimate"),
            "timeline_duration": features.get("timeline_duration"),
        },
    }


def extract_metadata_from_document(file) -> dict[str, Any]:
    """
    Extract structured metadata from an uploaded contract document.

    Args:
        file: File-like object (e.g. Django UploadedFile) - PDF supported.

    Returns:
        Dict with keys: issuing_agency, title, jurisdiction, features.
        Safe to pass into ContractSerializer for create/update.

    Raises:
        ExtractionError: On unsupported format, extraction failure, or LLM error.
    """
    text = _extract_text(file)
    # Truncate very long documents to stay within context limits
    max_chars = getattr(settings, "EXTRACTION_MAX_TEXT_CHARS", 50000)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n\n[... document truncated ...]"

    provider = getattr(settings, "EXTRACTION_LLM_PROVIDER", "groq").lower()
    if provider == "groq":
        data = _call_groq(text)
    elif provider == "openai":
        data = _call_openai(text)
    else:
        raise ExtractionError(
            f"Unknown EXTRACTION_LLM_PROVIDER: {provider}. Use 'groq' or 'openai'."
        )

    return _normalize_result(data)
