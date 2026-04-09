"""
Normalize raw scraped events into the enriched format expected by the frontend.

Reuses the industry/location/capability inference logic that currently lives in
the frontend route.ts, ported to Python so normalization happens at scrape time.
"""

from __future__ import annotations

import re
from typing import Optional

from webscraping.v2.models import RawScrapedEvent, EnrichedEvent, AttachmentExtraction
from webscraping.v2.utils import make_event_id


# ---------------------------------------------------------------------------
# California counties & cities for location extraction
# ---------------------------------------------------------------------------

CA_COUNTIES = [
    "Alameda", "Alpine", "Amador", "Butte", "Calaveras", "Colusa",
    "Contra Costa", "Del Norte", "El Dorado", "Fresno", "Glenn", "Humboldt",
    "Imperial", "Inyo", "Kern", "Kings", "Lake", "Lassen", "Los Angeles",
    "Madera", "Marin", "Mariposa", "Mendocino", "Merced", "Modoc", "Mono",
    "Monterey", "Napa", "Nevada", "Orange", "Placer", "Plumas", "Riverside",
    "Sacramento", "San Benito", "San Bernardino", "San Diego", "San Francisco",
    "San Joaquin", "San Luis Obispo", "San Mateo", "Santa Barbara", "Santa Clara",
    "Santa Cruz", "Shasta", "Sierra", "Siskiyou", "Solano", "Sonoma",
    "Stanislaus", "Sutter", "Tehama", "Trinity", "Tulare", "Tuolumne",
    "Ventura", "Yolo", "Yuba",
]

CA_CITIES = [
    "Sacramento", "Los Angeles", "San Francisco", "San Diego", "San Jose",
    "Oakland", "Fresno", "Long Beach", "Bakersfield", "Anaheim",
    "Santa Ana", "Riverside", "Stockton", "Irvine", "Chula Vista",
    "Santa Rosa", "Modesto", "Visalia", "Elk Grove", "Roseville",
    "Folsom", "Redding", "Yountville", "Benicia", "Porterville",
    "Hollister", "Eureka", "Patton", "Coalinga", "Vacaville",
    "Rancho Cordova", "West Sacramento",
]

_SKIP_LOCATION_WORDS = {
    "state", "university", "department", "office", "service",
    "services", "business", "agency",
}


def extract_location(title: str, description: str, agency: str) -> str:
    """Infer location from title, description, and agency name."""
    text = f"{title}\n{description}"

    # Explicit "City: X" or "County: X"
    city_field = re.search(r"\bCity:\s*([A-Za-z\s]+?)(?:\n|$)", description)
    county_field = re.search(r"\bCounty:\s*([A-Za-z\s]+?)(?:\n|$)", description)
    if city_field:
        city = city_field.group(1).strip()
        if 1 < len(city) < 40:
            county = county_field.group(1).strip() if county_field else ""
            return f"{city}, {county} County, CA" if county else f"{city}, CA"
    if county_field:
        county = county_field.group(1).strip()
        if 1 < len(county) < 40:
            return f"{county} County, CA"

    # "City, CA" pattern
    m = re.search(
        r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*(?:CA|California)(?:\s+\d{5})?",
        text,
    )
    if m:
        city = m.group(1).strip()
        if city.lower() not in _SKIP_LOCATION_WORDS and 1 < len(city) < 40:
            return f"{city}, CA"

    # County names
    for county in CA_COUNTIES:
        if f"{county} County" in text:
            return f"{county} County, CA"

    # City names
    for city in CA_CITIES:
        pattern = rf"\b{re.escape(city)}\b"
        if re.search(pattern, text, re.IGNORECASE):
            return f"{city}, CA"

    return "California"


# ---------------------------------------------------------------------------
# Industry inference
# ---------------------------------------------------------------------------

_INDUSTRY_RULES: list[tuple[str, str]] = [
    (r"\bwanted\s+to\s+lease\b|\blease\s+(office|warehouse|space|property)\b|\b(nusf|rentable\s+square|leasable)\b", "Real Estate & Leasing"),
    (r"\b(software|saas|cloud|cyber|data\s*base|network|telecom|it\s+consult|electronic.*system|computer|digital)\b", "IT Services"),
    (r"\b(janitorial|cleaning|custodial|sanitation|housekeeping)\b", "Facilities Maintenance"),
    (r"\b(hvac|heating|ventilation|cooling|plumbing|elevator|generator|preventive\s+maintenance|equipment\s+maintenance)\b", "Facilities Maintenance"),
    (r"\b(construction|building\s+construct|demolition|renovation|roofing|concrete|masonry|paving|asphalt|grading|excavation|siding)\b", "Construction"),
    (r"\b(road|highway|bridge|pavement|culvert|striping|high\s+friction)\b", "Construction"),
    (r"\b(hazardous\s+waste|waste\s+removal|disposal|remediation|abatement|contamination|environmental\s+test)\b", "Environmental Services"),
    (r"\b(landscaping|grounds|irrigation|vegetation|tree\s+trimming|pest\s+control|weed)\b", "Environmental Services"),
    (r"\b(courier|delivery|shipping|freight|towing|transportation\s+service|moving\s+service)\b", "Transportation"),
    (r"\b(vehicle|fleet|automotive|truck|bus|tractor|trailer)\b", "Equipment & Supplies"),
    (r"\b(medical|clinical|patient|hospital|nursing|pharmacy|bio.?hazardous|cytox)\b", "Healthcare"),
    (r"\b(treatment\s+services|rehabilitation|behavioral|mental\s+health|sex\s+offender|counseling|day\s+reporting)\b", "Social & Rehabilitation Services"),
    (r"\b(engineer|structural|civil|mechanical|geotechnical|survey|architect)\b", "Engineering"),
    (r"\b(security|guard|surveillance|patrol|alarm)\b", "Security"),
    (r"\b(fire\s+train|live\s+fire|emergency|fuel\s+reduction)\b", "Public Safety & Emergency"),
    (r"\b(legal|attorney|counsel|litigation|investigat)\b", "Legal Services"),
    (r"\b(food\s+service|bakery|kitchen|catering|vending)\b", "Food & Agriculture"),
    (r"\b(education|school|university|training|curriculum)\b", "Education"),
    (r"\b(consult|advisory|strategy|assessment|audit)\b", "Consulting"),
    (r"\b(supply|supplies|equipment|materials|procurement|furnish|rental)\b", "Equipment & Supplies"),
    (r"\b(research|laboratory|scientific|study)\b", "Research & Development"),
    (r"\b(printing|print|envelope|publishing)\b", "Manufacturing"),
    (r"\b(portable\s+toilet|refuse|recycling|trash|garbage)\b", "Environmental Services"),
    (r"\b(maintenance|repair)\b", "Facilities Maintenance"),
]

_DEPT_FALLBACKS: list[tuple[str, str]] = [
    ("transportation", "Transportation"),
    ("dot", "Transportation"),
    ("health", "Healthcare"),
    ("corrections", "Social & Rehabilitation Services"),
    ("rehab", "Social & Rehabilitation Services"),
    ("education", "Education"),
    ("parks", "Environmental Services"),
    ("forestry", "Environmental Services"),
    ("fish", "Environmental Services"),
    ("wildlife", "Environmental Services"),
    ("general services", "Facilities Maintenance"),
    ("technology", "IT Services"),
    ("statewide stpd", "IT Services"),
    ("military", "Public Safety & Emergency"),
    ("water", "Environmental Services"),
    ("veteran", "Healthcare"),
]


def infer_industry(agency: str, title: str = "", description: str = "") -> str:
    """Infer industry from text content, mirroring frontend logic."""
    text = f"{agency} {title} {description}".lower()

    for pattern, industry in _INDUSTRY_RULES:
        # Skip "security" match if "cyber" is present
        if industry == "Security" and "cyber" in text:
            continue
        if re.search(pattern, text):
            return industry

    dept = agency.lower()
    for keyword, industry in _DEPT_FALLBACKS:
        if keyword in dept:
            return industry

    return "Government Services"


# ---------------------------------------------------------------------------
# Capability inference (mirrors frontend inferCapabilities)
# ---------------------------------------------------------------------------

_CAP_RULES: list[tuple[str, str]] = [
    (r"\b(cybersecurity|infosec|security\s+assess|penetration|firewall)\b", "Cybersecurity"),
    (r"\b(cloud|aws|azure|gcp|saas|iaas|migration)\b", "Cloud Services"),
    (r"\b(data\s+analytics|analytics|reporting|visualization|dashboard)\b", "Data Analytics"),
    (r"\b(software\s+dev|application\s+dev|custom\s+software|programming)\b", "Software Development"),
    (r"\b(web\s+dev|website|frontend|backend|fullstack)\b", "Web Development"),
    (r"\b(database|sql|data\s*base\s+manage)\b", "Database Management"),
    (r"\b(network|lan|wan|fiber|wireless|telecom)\b", "Network Infrastructure"),
    (r"\b(construction|general\s+contractor|demolition|grading|excavat)\b", "Building Construction"),
    (r"\b(road|highway|paving|asphalt|bridge|pavement|striping|culvert)\b", "Road & Highway Construction"),
    (r"\b(renovation|remodel|rehabilitat|restoration|retrofit|siding|roofing)\b", "Renovation & Remodeling"),
    (r"\b(civil\s+engineer|structural\s+engineer|geotechnical|survey)\b", "Civil Engineering"),
    (r"\b(electrical|wiring|power\s+distribut|lighting|generator|solar)\b", "Electrical Systems"),
    (r"\b(plumbing|piping|water\s+system|sewer|drain|storm\s*water)\b", "Plumbing & Piping"),
    (r"\b(janitorial|cleaning|custodial|sanitation|housekeeping)\b", "Janitorial & Cleaning"),
    (r"\b(hvac|heating|ventilation|cooling|air\s+balanc|chiller)\b", "HVAC Services"),
    (r"\b(landscap|grounds|irrigation|vegetation|horticultur|tree\s+trim)\b", "Landscaping & Grounds"),
    (r"\b(pest\s+control|extermination|fumigat)\b", "Pest Control"),
    (r"\b(waste|refuse|recycl|disposal|trash|garbage|hazardous\s+waste)\b", "Waste Management & Disposal"),
    (r"\b(remediat|environmental\s+clean|contamination|hazmat|abatement)\b", "Environmental Remediation"),
    (r"\b(consult|advisory|strateg|assessment)\b", "Consulting & Advisory"),
    (r"\b(project\s+manage|program\s+manage|oversight|pmo)\b", "Project Management"),
    (r"\b(training|workshop|curriculum|instruction|education|course)\b", "Training & Support"),
    (r"\b(staffing|temporary|recruiting|personnel|labor\s+service)\b", "Staffing & Recruiting"),
    (r"\b(security\s+guard|armed\s+guard|unarmed\s+guard|patrol|surveillance)\b", "Security Guard Services"),
    (r"\b(medical|clinical|health\s+service|nursing|pharmacy)\b", "Medical & Health Services"),
    (r"\b(vehicle|fleet|automotive|towing|truck|tractor)\b", "Vehicle & Fleet Services"),
    (r"\b(courier|delivery|shipping|freight|pick\s*up.*deliver)\b", "Courier & Delivery"),
    (r"\b(printing|print\s+service|envelope|publishing)\b", "Printing & Publishing"),
    (r"\b(food\s+service|catering|kitchen|bakery|vending)\b", "Food Services & Catering"),
]

_INDUSTRY_FALLBACK_CAPS: dict[str, list[str]] = {
    "Construction": ["Building Construction"],
    "Engineering": ["Civil Engineering"],
    "IT Services": ["Software Development", "Cloud Services"],
    "Facilities Maintenance": ["Facilities Maintenance & Repair"],
    "Environmental Services": ["Environmental Testing & Monitoring"],
    "Transportation": ["Transportation & Transit"],
    "Equipment & Supplies": ["Equipment Procurement"],
    "Healthcare": ["Medical & Health Services"],
    "Social & Rehabilitation Services": ["Social Services & Outreach"],
    "Security": ["Security Guard Services"],
    "Public Safety & Emergency": ["Emergency Management"],
    "Legal Services": ["Legal Services"],
    "Food & Agriculture": ["Food Services & Catering"],
    "Education": ["Training & Support"],
    "Consulting": ["Consulting & Advisory"],
    "Research & Development": ["Research & Development"],
    "Manufacturing": ["Printing & Publishing"],
    "Real Estate & Leasing": ["Facilities Maintenance & Repair"],
    "Government Services": ["Consulting & Advisory"],
}


def infer_capabilities(title: str, description: str, industry: str) -> list[str]:
    """Infer capabilities from text, with industry fallback."""
    text = f"{title} {description}".lower()
    caps = []
    seen = set()

    for pattern, cap in _CAP_RULES:
        if cap not in seen and re.search(pattern, text):
            caps.append(cap)
            seen.add(cap)

    if caps:
        return caps

    fallback = _INDUSTRY_FALLBACK_CAPS.get(industry, ["Consulting & Advisory"])
    return list(fallback)


# ---------------------------------------------------------------------------
# Estimated value extraction
# ---------------------------------------------------------------------------

def extract_estimated_value(description: str) -> str:
    m = re.search(r"\$[\d,]+(?:K|M)?(?:\s*[-\u2013]\s*\$?[\d,]+(?:K|M)?)?", description)
    return m.group(0) if m else "TBD"


# ---------------------------------------------------------------------------
# Main normalize function
# ---------------------------------------------------------------------------

def normalize_event(
    raw: RawScrapedEvent,
    extraction: Optional[AttachmentExtraction] = None,
) -> EnrichedEvent:
    """
    Transform a RawScrapedEvent (+ optional attachment extraction) into
    an EnrichedEvent ready for the frontend.
    """
    industry = infer_industry(raw.issuing_agency, raw.title, raw.description)
    capabilities = infer_capabilities(raw.title, raw.description, industry)

    # Location: prefer extraction data, fall back to text inference
    location = "California"
    if extraction and extraction.location_details:
        location = extraction.location_details[0]
    else:
        location = extract_location(raw.title, raw.description, raw.issuing_agency)

    # Value: prefer extraction, fall back to text
    estimated_value = "TBD"
    if extraction and extraction.contract_value_estimate:
        estimated_value = extraction.contract_value_estimate
    else:
        estimated_value = extract_estimated_value(raw.description)

    # Build attachment rollup if extraction exists
    attachment_rollup = None
    if extraction:
        attachment_rollup = {
            "summary": extraction.key_requirements_summary,
            "text": extraction.attachment_text_rollup,
            "pdfsProcessed": extraction.pdfs_processed,
        }

    return EnrichedEvent(
        id=make_event_id(raw.source_id, raw.source_event_id),
        source_id=raw.source_id,
        source_event_id=raw.source_event_id,
        source_url=raw.source_url,
        title=raw.title.replace("\u00bf", "\u2013"),  # fix encoding artifact
        description=raw.description[:2000],
        agency=raw.issuing_agency,
        location=location,
        deadline=raw.due_date or "",
        estimated_value=estimated_value,
        industry=industry,
        procurement_type=raw.procurement_type,
        naics_codes=extraction.naics_codes if extraction else [],
        capabilities=capabilities,
        certifications=extraction.certifications_required if extraction else [],
        contact=raw.contact,
        clearances_required=extraction.clearances_required if extraction else [],
        set_aside_types=extraction.set_aside_types if extraction else [],
        deliverables=extraction.deliverables if extraction else [],
        contract_duration=extraction.contract_duration if extraction else None,
        evaluation_criteria=extraction.evaluation_criteria if extraction else [],
        attachment_rollup=attachment_rollup,
        posted_date=raw.posted_date,
        scraped_at=raw.scraped_at,
    )
