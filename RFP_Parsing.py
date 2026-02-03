import csv
import json
import re
from datetime import datetime
from typing import List, Dict, Any, Optional
from zoneinfo import ZoneInfo

# NOTES
# We will probably need to scrape more attachments in order to get total requirements, 
# and then use an LLM to synthesize

# Config

SOURCE_NAME = "Cal eProcure"
SOURCE_PREFIX = "caleprocure"
DEFAULT_STATE = "CA"
DEFAULT_TZ = ZoneInfo("America/Los_Angeles")  # handles PST/PDT

# Broad taxonomy tags across many contract types
TAG_RULES = {
    "it/software": ["software", "application", "saas", "platform", "implementation", "integration", "api", "database"],
    "cybersecurity": ["cyber", "security", "soc", "siem", "penetration", "vulnerability", "zero trust", "incident response"],
    "data/ai": ["data", "analytics", "warehouse", "etl", "machine learning", "ai", "model", "llm", "forecast", "dashboard", "bi"],
    "cloud/infrastructure": ["cloud", "aws", "azure", "gcp", "infrastructure", "devops", "kubernetes", "network", "hosting"],
    "professional services": ["consulting", "advisory", "strategy", "assessment", "planning", "program management", "project management"],
    "staffing": ["staffing", "temporary", "augmentation", "resource", "recruit", "labor"],
    "training/education": ["training", "workshop", "curriculum", "instruction", "education", "course", "learning"],
    "facilities/maintenance": ["maintenance", "janitorial", "repair", "hvac", "plumbing", "electrical", "facility", "grounds", "custodial"],
    "construction/capital": ["construction", "build", "renovation", "replacement", "demolition", "grading", "pavement", "architect", "engineering"],
    "supplies/equipment": ["supply", "supplies", "equipment", "materials", "parts", "furnish", "procure", "hardware"],
    "fleet/vehicles": ["vehicle", "fleet", "bus", "truck", "ev", "charging", "transit", "transportation"],
    "health/social services": ["health", "medical", "clinic", "patient", "behavioral", "social services", "case management"],
    "legal/compliance": ["legal", "audit", "compliance", "risk", "policy", "regulatory"],
}

# best-effort location patterns (often missing in CSV)
LOCATION_PATTERNS = [
    re.compile(r"\bCity of\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b"),
    re.compile(r"\bCounty of\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b"),
    re.compile(r"\b([A-Z][a-zA-Z]+)\s+County\b"),
    re.compile(r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\s+CA\b"),
]

def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()

def parse_caleprocure_datetime(dt_str: str) -> Optional[str]:
    """
    Parses:
      '12/05/2025 11:51AM PST'
      '02/02/2026  2:00PM PST'
    -> ISO8601 with tz offset.
    """
    if not dt_str:
        return None
    s = " ".join(dt_str.strip().split())
    s = re.sub(r"\s+(PST|PDT)\b", "", s, flags=re.IGNORECASE).strip()

    for fmt in ("%m/%d/%Y %I:%M%p", "%m/%d/%Y %I:%M %p"):
        try:
            dt = datetime.strptime(s, fmt).replace(tzinfo=DEFAULT_TZ)
            return dt.isoformat()
        except ValueError:
            continue
    return None

def extract_tags(title: str, description: str) -> List[str]:
    text = f"{title} {description}".lower()

    tokens = set(re.findall(r"[a-z0-9]+", text))

    def has_keyword(k: str) -> bool:
        k = k.lower().strip()

        if " " in k:
            return k in text

        if len(k) <= 2:
            return k in tokens

        if k in tokens:
            return True
        return re.search(rf"\b{re.escape(k)}\b", text) is not None

    tags = set()
    for tag, keywords in TAG_RULES.items():
        if any(has_keyword(k) for k in keywords):
            tags.add(tag)

    return sorted(tags)


def extract_locations(title: str, description: str) -> List[str]:
    blob = f"{title} {description}"
    candidates = set()

    for pat in LOCATION_PATTERNS:
        for m in pat.finditer(blob):
            candidates.add(m.group(0).strip())

    # common pattern in titles 
    m = re.search(r"\b([A-Z][a-zA-Z]+)\s+Fire Station\b", title)
    if m:
        candidates.add(f"{m.group(1)} Fire Station")

    return sorted(candidates)

def extract_requirements(description: str) -> List[str]:
    """
    Generic scope bullet heuristic (works across domains).
    Keeps sentences/clauses that look like scope.
    """
    desc = clean_text(description)
    if not desc:
        return []

    chunks = re.split(r"(?<=[.])\s+|;\s+", desc)
    chunks = [c.strip() for c in chunks if c.strip()]

    scope_verbs = [
        "provide", "perform", "develop", "design", "implement", "install", "deliver",
        "support", "maintain", "operate", "upgrade", "configure", "integrate",
        "analyze", "assess", "evaluate", "manage", "coordinate", "train",
        "construct", "build", "demolish", "replace", "renovate"
    ]
    scope_markers = ["includes", "including", "consist of", "scope", "services", "work consists"]

    keep = []
    for c in chunks:
        cl = c.lower()
        if any(v in cl for v in scope_verbs) or any(m in cl for m in scope_markers):
            keep.append(c if len(c) <= 220 else c[:217].rstrip() + "...")

    if not keep:
        keep = chunks[:2]

    # dedup preserve order
    seen = set()
    out = []
    for k in keep:
        key = k.lower()
        if key not in seen:
            seen.add(key)
            out.append(k)

    return out[:8]

def infer_onsite(tags: List[str]) -> Optional[bool]:
    # For demo honesty: only say True when it’s clearly physical.
    if any(t in tags for t in ["construction/capital", "facilities/maintenance", "fleet/vehicles"]):
        return True
    return None

def build_constraint_results(due_at_iso: Optional[str], url: Optional[str]) -> List[Dict[str, Any]]:
    results = []

    # deadline
    if due_at_iso:
        due_dt = datetime.fromisoformat(due_at_iso)
        now = datetime.now(tz=DEFAULT_TZ)
        results.append({
            "name": "deadline_not_passed",
            "status": "pass" if now <= due_dt else "fail",
            "reason": f"now={now.isoformat()} due_at={due_at_iso}"
        })
    else:
        results.append({
            "name": "deadline_not_passed",
            "status": "unknown",
            "reason": "No due date in CSV."
        })

    # CA-only jurisdiction (source-level constraint)
    results.append({
        "name": "jurisdiction_state_ca",
        "status": "pass",
        "reason": "Source is Cal eProcure (CA state portal)."
    })

    # URL sanity
    results.append({
        "name": "rfp_url_present",
        "status": "pass" if url else "fail",
        "reason": "Has event_url." if url else "Missing event_url."
    })

    return results

def row_to_json(row: Dict[str, str]) -> Dict[str, Any]:
    event_id = (row.get("event_id") or "").strip()
    url = (row.get("event_url") or "").strip() or None
    title = (row.get("title") or "").strip()
    description = row.get("description") or ""
    dept = (row.get("department") or "").strip() or None
    fmt = (row.get("format") or "").strip() or None

    posted_at = parse_caleprocure_datetime((row.get("start_date") or "").strip())
    due_at = parse_caleprocure_datetime((row.get("end_date") or "").strip())

    desc_clean = clean_text(description)
    tags = extract_tags(title, desc_clean)
    locations = extract_locations(title, desc_clean)
    requirements = extract_requirements(desc_clean)

    return {
        "rfp_id": f"{SOURCE_PREFIX}:{event_id}" if event_id else None,
        "source": SOURCE_NAME,
        "rfp_url": url,
        "title": title or None,
        "issuing_agency": dept,
        "jurisdiction": {"state": DEFAULT_STATE, "county": None, "city": None},
        "posted_at": posted_at,
        "due_at": due_at,
        "procurement_type": fmt,
        "contact": {
            "name": (row.get("contact_name") or "").strip() or None,
            "email": (row.get("contact_email") or "").strip() or None,
            "phone": (row.get("contact_phone") or "").strip() or None
        },
        "raw_text": desc_clean,
        "summary": [desc_clean[:180] + "..." if len(desc_clean) > 180 else desc_clean] if desc_clean else [],
        "requirements": requirements,
        "features": {
            "industry_tags": tags,
            "work_locations": locations,
            "onsite_required": infer_onsite(tags),

            # CSV-only limitations: keep explicit/unknown fields empty
            "required_certifications": [],
            "required_clearances": [],
            "naics_codes": [],
            "submission_method": None,
            "contract_value_estimate": None
        },
        "constraint_results": build_constraint_results(due_at, url),
        "parse_meta": {
            "method": "csv_heuristics",
            "warnings": [
                "CSV-only parse: set-asides/certifications, evaluation criteria, and full submission instructions likely require event page + attachments."
            ]
        }
    }

def convert(csv_path: str, out_path: str) -> None:
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rfps = [row_to_json(row) for row in reader]

    with open(out_path, "w", encoding="utf-8") as out:
        json.dump(rfps, out, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    import sys
    if len(sys.argv) != 3:
        print("Usage: python rfp_parse_csv.py <input.csv> <output.json>")
        raise SystemExit(1)

    convert(sys.argv[1], sys.argv[2])
    print(f"Wrote {sys.argv[2]}")
