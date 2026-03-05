"""
Batch extraction of structured data from RFP attachment PDFs.

Reads PDFs from S3 bucket (civitas-uploads/scrapes/caleprocure/attachments/),
extracts text with pdfplumber, sends to Groq LLM for structured extraction,
and writes merged results to attachment_extractions.json.

Usage:
    python extract_attachments.py                  # process all events
    python extract_attachments.py --event 3600/0000037663  # process one event
    python extract_attachments.py --dry-run        # list what would be processed

Requires: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_STORAGE_BUCKET_NAME,
          GROQ_API_KEY in environment or .env file.
"""

import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import boto3
import pdfplumber
from dotenv import load_dotenv
from groq import Groq
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Load .env from back_end (has AWS + GROQ keys)
_BACKEND_ENV = Path(__file__).resolve().parent.parent / "back_end" / ".env"
if _BACKEND_ENV.exists():
    load_dotenv(_BACKEND_ENV)

# Also try the win26-Team9/back_end/.env (non-worktree)
_MAIN_BACKEND_ENV = Path(__file__).resolve().parent.parent / "win26-Team9" / "back_end" / ".env"
if _MAIN_BACKEND_ENV.exists():
    load_dotenv(_MAIN_BACKEND_ENV, override=False)

S3_BUCKET = os.environ.get("AWS_STORAGE_BUCKET_NAME", "civitas-uploads")
S3_PREFIX = "scrapes/caleprocure/attachments/"
S3_REGION = os.environ.get("AWS_S3_REGION_NAME", "us-east-1")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = "llama-3.1-8b-instant"
MAX_TEXT_CHARS = 15_000  # truncate long PDFs (Groq free tier has 6000 TPM limit)

OUTPUT_FILE = Path(__file__).resolve().parent / "attachment_extractions.json"

# How long to sleep between Groq calls to avoid rate limits
GROQ_SLEEP_SECONDS = 2

# ---------------------------------------------------------------------------
# PDF priority filtering — determines which attachments to process
# ---------------------------------------------------------------------------

HIGH_PRIORITY_PATTERNS = [
    r"Specification",
    r"Bid",
    r"Instr",
    r"SOW",
    r"Scope",
    r"RFP",
    r"RFQ",
    r"Solicitation",
    r"Statement.*Work",
]

MEDIUM_PRIORITY_PATTERNS = [
    r"Addendum",
    r"Amendment",
    r"Agreement",
    r"Attachment",
    r"Exhibit",
    r"Contract",
]

SKIP_PATTERNS = [
    r"Drawing",
    r"Job.?Walk",
    r"Attendee",
    r"Sign.?In",
    r"Photo",
    r"Map",
    r"Floor.?Plan",
]


def classify_pdf(filename: str) -> str:
    """Classify a PDF filename as 'high', 'medium', or 'skip'."""
    name = filename.replace("_", " ")
    for pat in SKIP_PATTERNS:
        if re.search(pat, name, re.IGNORECASE):
            return "skip"
    for pat in HIGH_PRIORITY_PATTERNS:
        if re.search(pat, name, re.IGNORECASE):
            return "high"
    for pat in MEDIUM_PRIORITY_PATTERNS:
        if re.search(pat, name, re.IGNORECASE):
            return "medium"
    # Default to medium — better to process than miss
    return "medium"


# ---------------------------------------------------------------------------
# LLM extraction prompt
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

_SCHEMA_STR = json.dumps(EXTRACTION_SCHEMA, indent=2)

EXTRACTION_PROMPT = f"""You are analyzing a government RFP (Request for Proposal) or bid solicitation attachment document. Extract structured metadata from the document text below. Return valid JSON only — no markdown, no explanation.

Expected schema:
{_SCHEMA_STR}

Rules:
- naics_codes: NAICS codes mentioned (e.g. "561720", "236220"). Include the code numbers only.
- certifications_required: Required certifications (e.g. "Small Business (SB)", "DVBE", "DIR Registration", "Contractor's License Class B")
- clearances_required: Security clearances needed (e.g. "Live Scan", "Background Check", "Secret Clearance")
- set_aside_types: Set-aside categories (e.g. "Small Business", "DVBE", "8(a)", "HUBZone", "SBE")
- capabilities_required: Specific skills/capabilities required (e.g. "HVAC maintenance", "janitorial services", "software development", "structural engineering")
- contract_value_estimate: Total estimated value as a string (e.g. "$500,000" or "500000"). Use null if not mentioned.
- contract_duration: Duration of the contract (e.g. "36 months", "3 years", "1 year with 2 option years")
- location_details: Where work is performed (e.g. "Sacramento, CA", "Stockton, CA 95215")
- onsite_required: Whether physical onsite presence is required. null if unclear.
- key_requirements_summary: 2-3 sentence summary of what this RFP is asking for.
- deliverables: Specific deliverables or services (e.g. "Monthly cleaning services", "Fire alarm inspection reports")
- evaluation_criteria: How bids will be evaluated (e.g. "Lowest responsive bid", "Best value", "Technical score 60%, Cost 40%")

If a field is not mentioned in the text, use an empty list [] for arrays, null for scalars, or "Unknown" for the summary.

Document text:
---
{{text}}
---

Return ONLY the JSON object, no other text."""


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------

def get_s3_client():
    """Create an S3 client from env vars."""
    return boto3.client(
        "s3",
        region_name=S3_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def s3_safe_id(event_id: str) -> str:
    """Convert event_id from JSON format (3600/0000037663) to S3 format (3600_0000037663)."""
    return event_id.replace("/", "_")


def s3_id_to_event_id(s3_id: str) -> str:
    """Convert S3 folder name (3600_0000037663) back to event_id format (3600/0000037663).
    The first underscore-separated segment is the department code."""
    parts = s3_id.split("_", 1)
    if len(parts) == 2:
        return f"{parts[0]}/{parts[1]}"
    return s3_id


def list_event_ids(s3) -> list[str]:
    """List all event_id prefixes under the attachments prefix.
    S3 stores them as flat folders: 0890_0000038160/, 3790_0000037817/
    Returns event_ids in JSON format: 0890/0000038160, 3790/0000037817
    """
    paginator = s3.get_paginator("list_objects_v2")
    event_ids = set()
    for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=S3_PREFIX, Delimiter="/"):
        for prefix_obj in page.get("CommonPrefixes", []):
            # e.g. "scrapes/caleprocure/attachments/0890_0000038160/"
            s3_folder = prefix_obj["Prefix"][len(S3_PREFIX):].rstrip("/")
            event_id = s3_id_to_event_id(s3_folder)
            event_ids.add(event_id)
    return sorted(event_ids)


def list_pdfs_for_event(s3, event_id: str) -> list[dict]:
    """List PDF files for a given event_id, with priority classification."""
    prefix = f"{S3_PREFIX}{s3_safe_id(event_id)}/"
    paginator = s3.get_paginator("list_objects_v2")
    pdfs = []
    for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            filename = key.split("/")[-1]
            if not filename.lower().endswith(".pdf"):
                continue
            priority = classify_pdf(filename)
            pdfs.append({
                "key": key,
                "filename": filename,
                "size": obj["Size"],
                "priority": priority,
            })
    # Sort: high first, then medium
    order = {"high": 0, "medium": 1, "skip": 2}
    pdfs.sort(key=lambda p: order.get(p["priority"], 1))
    return pdfs


def download_pdf_from_s3(s3, key: str) -> str:
    """Download a PDF from S3 to a temp file, return its path."""
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        s3.download_file(S3_BUCKET, key, tmp.name)
    except Exception as e:
        os.unlink(tmp.name)
        raise RuntimeError(f"Failed to download s3://{S3_BUCKET}/{key}: {e}") from e
    return tmp.name


# ---------------------------------------------------------------------------
# PDF text extraction
# ---------------------------------------------------------------------------

def extract_text_from_pdf(filepath: str) -> str:
    """Extract text from a PDF file using pdfplumber."""
    text_parts = []
    try:
        with pdfplumber.open(filepath) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
    except Exception as e:
        raise RuntimeError(f"Failed to extract text from PDF: {e}") from e

    text = "\n\n".join(text_parts).strip()
    return text


# ---------------------------------------------------------------------------
# Groq LLM extraction
# ---------------------------------------------------------------------------

def call_groq(text: str) -> dict[str, Any]:
    """Send text to Groq LLM for structured extraction."""
    client = Groq(api_key=GROQ_API_KEY)
    prompt = EXTRACTION_PROMPT.replace("{text}", text)

    response = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
    )
    raw = response.choices[0].message.content.strip()
    return parse_llm_json(raw)


def parse_llm_json(raw: str) -> dict[str, Any]:
    """Parse JSON from LLM response, handling markdown code blocks."""
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
        raise RuntimeError(f"LLM returned invalid JSON: {e}\nRaw: {raw[:500]}") from e


def normalize_extraction(data: dict[str, Any]) -> dict[str, Any]:
    """Ensure extraction has expected structure with safe defaults."""
    return {
        "naics_codes": data.get("naics_codes") or [],
        "certifications_required": data.get("certifications_required") or [],
        "clearances_required": data.get("clearances_required") or [],
        "set_aside_types": data.get("set_aside_types") or [],
        "capabilities_required": data.get("capabilities_required") or [],
        "contract_value_estimate": data.get("contract_value_estimate"),
        "contract_duration": data.get("contract_duration"),
        "location_details": data.get("location_details") or [],
        "onsite_required": data.get("onsite_required"),
        "key_requirements_summary": data.get("key_requirements_summary") or "Unknown",
        "deliverables": data.get("deliverables") or [],
        "evaluation_criteria": data.get("evaluation_criteria") or [],
    }


# ---------------------------------------------------------------------------
# Multi-PDF merge
# ---------------------------------------------------------------------------

def merge_extractions(extractions: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Merge multiple per-PDF extractions into a single result.
    - Lists: union (deduplicated)
    - Scalars: first non-null value
    """
    if not extractions:
        return normalize_extraction({})
    if len(extractions) == 1:
        return normalize_extraction(extractions[0])

    merged: dict[str, Any] = {}
    list_fields = [
        "naics_codes", "certifications_required", "clearances_required",
        "set_aside_types", "capabilities_required", "location_details",
        "deliverables", "evaluation_criteria",
    ]
    scalar_fields = [
        "contract_value_estimate", "contract_duration", "onsite_required",
        "key_requirements_summary",
    ]

    for field in list_fields:
        combined = []
        seen = set()
        for ext in extractions:
            for item in (ext.get(field) or []):
                item_lower = item.strip().lower() if isinstance(item, str) else str(item)
                if item_lower not in seen:
                    seen.add(item_lower)
                    combined.append(item.strip() if isinstance(item, str) else item)
        merged[field] = combined

    for field in scalar_fields:
        merged[field] = None
        for ext in extractions:
            val = ext.get(field)
            if val is not None and val != "Unknown" and val != "":
                merged[field] = val
                break

    return normalize_extraction(merged)


# ---------------------------------------------------------------------------
# Process a single event
# ---------------------------------------------------------------------------

def process_event(s3, event_id: str, verbose: bool = True) -> dict[str, Any] | None:
    """
    Process all qualifying PDFs for an event.
    Returns merged extraction dict, or None if no text extracted.
    """
    pdfs = list_pdfs_for_event(s3, event_id)
    qualifying = [p for p in pdfs if p["priority"] != "skip"]

    if not qualifying:
        if verbose:
            print(f"  [{event_id}] No qualifying PDFs found (all skipped)")
        return None

    if verbose:
        total = len(pdfs)
        skipped = len(pdfs) - len(qualifying)
        print(f"  [{event_id}] {len(qualifying)} qualifying PDFs ({skipped} skipped)")

    extractions = []
    all_text_parts = []

    for pdf_info in qualifying:
        tmp_path = None
        try:
            tmp_path = download_pdf_from_s3(s3, pdf_info["key"])
            text = extract_text_from_pdf(tmp_path)

            if not text:
                if verbose:
                    print(f"    ✗ {pdf_info['filename']}: no text extracted")
                continue

            # Truncate long documents
            if len(text) > MAX_TEXT_CHARS:
                text = text[:MAX_TEXT_CHARS] + "\n\n[... document truncated ...]"

            if verbose:
                print(f"    ✓ {pdf_info['filename']}: {len(text)} chars")

            # Collect text for rollup
            all_text_parts.append(f"=== {pdf_info['filename']} ===\n{text}")

            # Call Groq for structured extraction
            result = call_groq(text)
            extractions.append(normalize_extraction(result))

            time.sleep(GROQ_SLEEP_SECONDS)

        except Exception as e:
            if verbose:
                print(f"    ✗ {pdf_info['filename']}: {e}")
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)

    if not extractions:
        return None

    merged = merge_extractions(extractions)

    # Add raw text rollup (truncated) for use in summaries
    full_text = "\n\n".join(all_text_parts)
    if len(full_text) > 5000:
        rollup_text = full_text[:5000] + "\n\n[... truncated ...]"
    else:
        rollup_text = full_text

    merged["attachment_text_rollup"] = rollup_text
    merged["pdfs_processed"] = [p["filename"] for p in qualifying if p["priority"] != "skip"]
    merged["total_pdfs_available"] = len(pdfs)

    return merged


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Extract structured data from RFP attachment PDFs")
    parser.add_argument("--event", help="Process a single event ID (e.g. 3600/0000037663)")
    parser.add_argument("--dry-run", action="store_true", help="List events and PDFs without processing")
    parser.add_argument("--force", action="store_true", help="Re-process events already in output")
    args = parser.parse_args()

    # Validate config
    if not GROQ_API_KEY:
        print("ERROR: GROQ_API_KEY not set. Set it in .env or environment.")
        sys.exit(1)

    aws_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
    aws_secret = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
    if not aws_key or not aws_secret:
        print("ERROR: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set.")
        print("Set them in back_end/.env or as environment variables.")
        sys.exit(1)

    s3 = get_s3_client()

    # Load existing extractions (for resume support)
    existing: dict[str, Any] = {}
    if OUTPUT_FILE.exists() and not args.force:
        with open(OUTPUT_FILE, "r") as f:
            existing = json.load(f)
        print(f"Loaded {len(existing)} existing extractions from {OUTPUT_FILE.name}")

    if args.event:
        # Process single event
        event_ids = [args.event]
    else:
        # Discover all events
        print("Discovering events in S3...")
        event_ids = list_event_ids(s3)
        print(f"Found {len(event_ids)} events with attachments")

    if args.dry_run:
        print("\n=== DRY RUN — listing events and their PDFs ===\n")
        for eid in event_ids:
            pdfs = list_pdfs_for_event(s3, eid)
            qualifying = [p for p in pdfs if p["priority"] != "skip"]
            status = "SKIP (already extracted)" if eid in existing else "TO PROCESS"
            print(f"  {eid} [{status}]: {len(qualifying)} qualifying / {len(pdfs)} total PDFs")
            for p in pdfs:
                tag = f"[{p['priority'].upper()}]"
                size_kb = p["size"] / 1024
                print(f"    {tag:10s} {p['filename']} ({size_kb:.0f} KB)")
        return

    # Process events
    to_process = [eid for eid in event_ids if eid not in existing or args.force]
    already_done = len(event_ids) - len(to_process)
    if already_done > 0:
        print(f"Skipping {already_done} already-extracted events (use --force to re-process)")

    if not to_process:
        print("Nothing to process!")
        return

    print(f"\nProcessing {len(to_process)} events...\n")

    for eid in tqdm(to_process, desc="Events"):
        try:
            result = process_event(s3, eid)
            if result:
                existing[eid] = result
                # Save after each event (for resume)
                with open(OUTPUT_FILE, "w") as f:
                    json.dump(existing, f, indent=2, ensure_ascii=False)
                tqdm.write(f"  ✓ {eid}: extracted ({len(result.get('naics_codes', []))} NAICS, "
                           f"{len(result.get('certifications_required', []))} certs, "
                           f"{len(result.get('capabilities_required', []))} capabilities)")
            else:
                tqdm.write(f"  ✗ {eid}: no data extracted")
        except Exception as e:
            tqdm.write(f"  ✗ {eid}: ERROR — {e}")

    print(f"\nDone! Extracted data for {len(existing)} events → {OUTPUT_FILE.name}")

    # Upload final extractions to S3 so the frontend can access them on Vercel
    try:
        s3.put_object(
            Bucket=S3_BUCKET,
            Key="scrapes/caleprocure/attachment_extractions.json",
            Body=json.dumps(existing, indent=2, ensure_ascii=False),
            ContentType="application/json",
        )
        print(f"☁ Uploaded extractions to S3: scrapes/caleprocure/attachment_extractions.json")
    except Exception as e:
        print(f"⚠ Failed to upload extractions to S3: {e}")


if __name__ == "__main__":
    main()
