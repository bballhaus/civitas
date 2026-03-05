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
    "rfp_id": "string|null",
    "issuing_agency": "string",
    "contractor_name": "string|null",
    "title": "string|null",
    "jurisdiction": {
        "state": "CA",
        "county": "string|null",
        "city": "string|null",
    },
    "dates": {
        "award_date": "string|null",
        "start_date": "string|null",
        "end_date": "string|null",
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
        "contract_value_max": "string|null",
        "timeline_duration": "string|null",
        "work_description": "string|null",
        "technology_stack": ["string"],
        "team_size": "string|null",
        "scope_keywords": ["string"],
        "contract_type": "string|null",
    },
}

# Schema in prompt; braces escaped so .format(text=...) doesn't interpret them
_SCHEMA_STR = json.dumps(EXTRACTION_SCHEMA, indent=2).replace("{", "{{").replace("}", "}}")

EXTRACTION_PROMPT = f"""Extract metadata from this document. It is a PAST SUCCESSFUL PROPOSAL - a government contract that the contractor won. Extract details that describe their demonstrated capabilities and past performance. Return valid JSON only, no markdown or explanation.

Expected schema:
{_SCHEMA_STR}

Rules:
- rfp_id: RFP number, solicitation ID, contract number, or similar reference (e.g. "RFP-2024-001", "GS-00F-12345")
- issuing_agency: the government agency or entity that awarded the contract (required)
- contractor_name: CRITICAL - the legal name of the COMPANY/CONTRACTOR/VENDOR that won and performed this contract. This is NOT the government agency. Search carefully for: the business entity name on the cover page or letterhead, text after "awarded to", "contractor:", "vendor:", "consultant:", "firm:", "performed by:", "submitted by:", or "prepared by:". Also check for company names in signature blocks, headers, footers, or "About Us" sections. Examples: "Acme Construction LLC", "Smith Engineering Inc.", "Global IT Solutions Corp". If multiple companies appear, pick the prime contractor. Return the full legal entity name. Return null ONLY if genuinely absent.
- title: contract/project title
- jurisdiction: Extract state, county, and city from the document. Prefer explicit mentions (e.g. "County of Inyo", "State of California", "City of Sacramento"). When only a city is named, infer the county from California geography (e.g. Sacramento → Sacramento County, Los Angeles → Los Angeles County, Baker → Inyo County). Default state to "CA" when the document clearly refers to California. Use null only when not mentioned and cannot be inferred.
- dates: ISO format YYYY-MM-DD when possible; award_date=when contract was awarded, start_date/end_date=period of performance
- required_certifications: certifications the contract required of the contractor (indicates capabilities the user holds)
- required_clearances: security clearances required (indicates clearances the user holds)
- contract_value_estimate: total contract value in dollars as string (e.g. "500000" or "$500,000")
- work_description: 1-3 sentences describing the type of work, scope, or services performed (e.g. "Fire station design and construction", "IT support and maintenance")
- industry_tags: relevant sectors (e.g. construction, IT, healthcare, facilities, environmental, transportation)
- naics_codes: North American Industry Classification codes if mentioned
- contract_value_max: if a value range is given, this is the upper bound (e.g. for "not to exceed $500,000" put "500000")
- technology_stack: specific technologies, frameworks, platforms, tools, or equipment used (e.g. "AWS", "Java", "SAP", "Salesforce", "AutoCAD", "pdfplumber"). Include both software and specialized equipment.
- team_size: number of people involved if mentioned (e.g. "5 FTEs", "team of 12", "3 technicians")
- scope_keywords: 3-5 keyword tags describing the type of work (e.g. ["janitorial services", "HVAC maintenance", "web development", "hazardous waste disposal"])
- contract_type: type of contract if mentioned (e.g. "Fixed Price", "Time & Materials", "Cost Plus Fixed Fee", "IDIQ", "BPA")

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
        if hasattr(file, "seek"):
            file.seek(0)
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


def _extract_text_from_docx(file) -> str:
    """Extract text from a DOCX file."""
    try:
        from docx import Document
    except ImportError:
        raise ExtractionError(
            "python-docx not installed. Run: pip install python-docx"
        ) from None

    try:
        if hasattr(file, "seek"):
            file.seek(0)
        doc = Document(file)
        text_parts = [p.text for p in doc.paragraphs if p.text.strip()]
    except Exception as e:
        raise ExtractionError(f"Failed to extract text from DOCX: {e}") from e

    text = "\n\n".join(text_parts).strip()
    if not text:
        raise ExtractionError("No text could be extracted from the DOCX")
    return text


def _extract_text_from_txt(file) -> str:
    """Extract text from a plain text file."""
    try:
        if hasattr(file, "seek"):
            file.seek(0)
        if hasattr(file, "read"):
            raw = file.read()
            text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        else:
            with open(file, "r", encoding="utf-8") as f:
                text = f.read()
    except Exception as e:
        raise ExtractionError(f"Failed to read text file: {e}") from e

    text = text.strip()
    if not text:
        raise ExtractionError("The text file is empty")
    return text


def _extract_text(file) -> str:
    """Extract text from an uploaded file. Supports PDF, DOCX, and TXT."""
    name = (getattr(file, "name", "") or "").lower()
    if name.endswith(".pdf"):
        return _extract_text_from_pdf(file)
    if name.endswith(".docx") or name.endswith(".doc"):
        return _extract_text_from_docx(file)
    if name.endswith(".txt"):
        return _extract_text_from_txt(file)
    raise ExtractionError(f"Unsupported file type. Supported: PDF, DOCX, TXT. Got: {name}")


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
    dates = data.get("dates") or {}
    features = data.get("features") or {}
    return {
        "rfp_id": data.get("rfp_id"),
        "issuing_agency": data.get("issuing_agency") or "Unknown",
        "contractor_name": data.get("contractor_name"),
        "title": data.get("title"),
        "jurisdiction": {
            "state": jurisdiction.get("state") or "CA",
            "county": jurisdiction.get("county"),
            "city": jurisdiction.get("city"),
        },
        "dates": {
            "award_date": dates.get("award_date"),
            "start_date": dates.get("start_date"),
            "end_date": dates.get("end_date"),
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
            "contract_value_max": features.get("contract_value_max"),
            "timeline_duration": features.get("timeline_duration"),
            "work_description": features.get("work_description"),
            "technology_stack": features.get("technology_stack") or [],
            "team_size": features.get("team_size"),
            "scope_keywords": features.get("scope_keywords") or [],
            "contract_type": features.get("contract_type"),
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
    else:
        raise ExtractionError(
            f"Unknown EXTRACTION_LLM_PROVIDER: {provider}. Use 'groq' or 'openai'."
        )

    return _normalize_result(data)
