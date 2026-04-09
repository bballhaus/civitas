import { NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { normalizeCapability } from "@/lib/capabilities";

interface ScrapedEvent {
  event_id: string;
  event_url: string;
  title: string;
  description: string;
  department: string;
  format: string;
  start_date: string;
  end_date: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
}

interface AttachmentExtraction {
  naics_codes: string[];
  certifications_required: string[];
  clearances_required: string[];
  set_aside_types: string[];
  capabilities_required: string[];
  contract_value_estimate: string | null;
  contract_duration: string | null;
  location_details: string[];
  onsite_required: boolean | null;
  key_requirements_summary: string;
  deliverables: string[];
  evaluation_criteria: string[];
  attachment_text_rollup?: string;
  pdfs_processed?: string[];
  total_pdfs_available?: number;
}

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});
const S3_BUCKET = process.env.AWS_S3_BUCKET || "civitas-ai";

// ---------------------------------------------------------------------------
// Server-side S3 cache (5-minute TTL)
// ---------------------------------------------------------------------------
interface S3Cache {
  data: { events: ScrapedEvent[] };
  extractions: Record<string, AttachmentExtraction>;
  timestamp: number;
}
let s3Cache: S3Cache | null = null;
const S3_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchS3Json<T>(key: string): Promise<T | null> {
  try {
    const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
    const resp = await s3.send(cmd);
    const body = await resp.Body?.transformToString("utf-8");
    if (!body) return null;
    return JSON.parse(body) as T;
  } catch (err) {
    console.warn(`Could not fetch s3://${S3_BUCKET}/${key}:`, err);
    return null;
  }
}

async function loadS3Data(): Promise<{
  events: ScrapedEvent[];
  extractions: Record<string, AttachmentExtraction>;
} | null> {
  const now = Date.now();
  if (s3Cache && now - s3Cache.timestamp < S3_CACHE_TTL) {
    return { events: s3Cache.data.events, extractions: s3Cache.extractions };
  }

  const data = await fetchS3Json<{ events: ScrapedEvent[] }>(
    "scrapes/caleprocure/all_events.json"
  );
  if (!data) return null;

  const extractions =
    (await fetchS3Json<Record<string, AttachmentExtraction>>(
      "scrapes/caleprocure/attachment_extractions.json"
    )) ?? {};

  s3Cache = { data, extractions, timestamp: now };
  return { events: data.events ?? [], extractions };
}

// Infer location from title, description, and department
function extractLocation(title: string, description: string, department: string): string {
  // Combine title + description for searching (title often has the best location info)
  const text = `${title}\n${description}`;

  // 1. Explicit "City: X" or "County: X" fields (common in lease & structured RFPs)
  const cityField = description.match(/\bCity:\s*([A-Za-z\s]+?)(?:\n|$)/);
  const countyField = description.match(/\bCounty:\s*([A-Za-z\s]+?)(?:\n|$)/);
  if (cityField) {
    const city = cityField[1].trim();
    if (city && city.length > 1 && city.length < 40) {
      const county = countyField ? countyField[1].trim() : "";
      return county ? `${city}, ${county} County, CA` : `${city}, CA`;
    }
  }
  if (countyField) {
    const county = countyField[1].trim();
    if (county && county.length > 1 && county.length < 40) {
      return `${county} County, CA`;
    }
  }

  // 2. "City, CA" or "City, California" patterns (e.g. "San Francisco, California 94599")
  const cityStateMatch = text.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*(?:CA|California)(?:\s+\d{5})?/
  );
  if (cityStateMatch) {
    const city = cityStateMatch[1].trim();
    // Exclude false positives (generic words that aren't cities)
    const skipWords = new Set(["State", "University", "Department", "Office", "Service", "Services", "Business", "Agency"]);
    if (!skipWords.has(city) && city.length > 1 && city.length < 40) {
      return `${city}, CA`;
    }
  }

  // 3. All 58 California counties — check "X County" in title + description
  const CA_COUNTIES = [
    "Alameda", "Alpine", "Amador", "Butte", "Calaveras", "Colusa",
    "Contra Costa", "Del Norte", "El Dorado", "Fresno", "Glenn", "Humboldt",
    "Imperial", "Inyo", "Kern", "Kings", "Lake", "Lassen", "Los Angeles",
    "Madera", "Marin", "Mariposa", "Mendocino", "Merced", "Modoc", "Mono",
    "Monterey", "Napa", "Nevada", "Orange", "Placer", "Plumas", "Riverside",
    "Sacramento", "San Benito", "San Bernardino", "San Diego", "San Francisco",
    "San Joaquin", "San Luis Obispo", "San Mateo", "Santa Barbara", "Santa Clara",
    "Santa Cruz", "Shasta", "Sierra", "Siskiyou", "Solano", "Sonoma",
    "Stanislaus", "Sutter", "Tehama", "Trinity", "Tulare", "Tuolumne",
    "Ventura", "Yolo", "Yuba"
  ];
  for (const county of CA_COUNTIES) {
    if (text.includes(`${county} County`)) {
      return `${county} County, CA`;
    }
  }

  // 4. Well-known California city names in title or description (no "County" suffix needed)
  const CA_CITIES = [
    "Sacramento", "Los Angeles", "San Francisco", "San Diego", "San Jose",
    "Oakland", "Fresno", "Long Beach", "Bakersfield", "Anaheim",
    "Santa Ana", "Riverside", "Stockton", "Irvine", "Chula Vista",
    "Santa Rosa", "Modesto", "Visalia", "Elk Grove", "Roseville",
    "Folsom", "Redding", "Yountville", "Benicia", "Porterville",
    "Hollister", "Eureka", "Patton", "Coalinga", "Vacaville",
    "Rancho Cordova", "West Sacramento"
  ];
  for (const city of CA_CITIES) {
    // Must appear as a word boundary — not inside another word
    const re = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) {
      return `${city}, CA`;
    }
  }

  // 5. "X and Y County" pattern (e.g. "Tulare and Fresno County")
  const multiCounty = text.match(/\b([A-Z][a-z]+)\s+and\s+([A-Z][a-z]+)\s+Count(?:y|ies)/);
  if (multiCounty) {
    return `${multiCounty[1]} and ${multiCounty[2]} County, CA`;
  }

  return "California";
}

// Infer industry from department, title, and description content
function inferIndustry(department: string, title?: string, description?: string): string {
  const text = `${department} ${title || ""} ${description || ""}`.toLowerCase();
  const d = department.toLowerCase();

  // Content-based inference (most accurate — looks at what the RFP actually asks for)
  // FIRST: catch lease/real estate before anything else — "building code" triggers false positives otherwise
  if (text.match(/\bwanted\s+to\s+lease\b/) || text.match(/\blease\s+(office|warehouse|space|property)\b/) || text.match(/\b(nusf|rentable\s+square|leasable)\b/)) return "Real Estate & Leasing";
  if (text.match(/\b(software|saas|cloud|cyber|data\s*base|network|telecom|it\s+consult|electronic.*system|computer|digital)\b/)) return "IT Services";
  if (text.match(/\b(janitorial|cleaning|custodial|sanitation|housekeeping)\b/)) return "Facilities Maintenance";
  if (text.match(/\b(hvac|heating|ventilation|cooling|plumbing|elevator|generator|preventive\s+maintenance|equipment\s+maintenance)\b/)) return "Facilities Maintenance";
  if (text.match(/\b(construction|building\s+construct|demolition|renovation|roofing|concrete|masonry|paving|asphalt|grading|excavation|siding)\b/)) return "Construction";
  if (text.match(/\b(road|highway|bridge|pavement|culvert|striping|high\s+friction)\b/)) return "Construction";
  if (text.match(/\b(hazardous\s+waste|waste\s+removal|disposal|remediation|abatement|contamination|environmental\s+test)\b/)) return "Environmental Services";
  if (text.match(/\b(landscaping|grounds|irrigation|vegetation|tree\s+trimming|pest\s+control|weed)\b/)) return "Environmental Services";
  if (text.match(/\b(courier|delivery|shipping|freight|towing|transportation\s+service|moving\s+service)\b/)) return "Transportation";
  if (text.match(/\b(vehicle|fleet|automotive|truck|bus|tractor|trailer)\b/)) return "Equipment & Supplies";
  if (text.match(/\b(medical|clinical|patient|hospital|nursing|pharmacy|bio.?hazardous|cytox)\b/)) return "Healthcare";
  if (text.match(/\b(treatment\s+services|rehabilitation|behavioral|mental\s+health|sex\s+offender|counseling|day\s+reporting)\b/)) return "Social & Rehabilitation Services";
  if (text.match(/\b(engineer|structural|civil|mechanical|geotechnical|survey|architect)\b/)) return "Engineering";
  if (text.match(/\b(security|guard|surveillance|patrol|alarm)\b/) && !text.includes("cyber")) return "Security";
  if (text.match(/\b(fire\s+train|live\s+fire|emergency|fuel\s+reduction)\b/)) return "Public Safety & Emergency";
  if (text.match(/\b(legal|attorney|counsel|litigation|investigat)\b/)) return "Legal Services";
  if (text.match(/\b(food\s+service|bakery|kitchen|catering|vending)\b/)) return "Food & Agriculture";
  if (text.match(/\b(education|school|university|training|curriculum)\b/)) return "Education";
  if (text.match(/\b(consult|advisory|strategy|assessment|audit)\b/)) return "Consulting";
  if (text.match(/\b(supply|supplies|equipment|materials|procurement|furnish|rental)\b/)) return "Equipment & Supplies";
  if (text.match(/\b(research|laboratory|scientific|study)\b/)) return "Research & Development";
  if (text.match(/\b(printing|print|envelope|publishing)\b/)) return "Manufacturing";
  if (text.match(/\b(portable\s+toilet|refuse|recycling|trash|garbage)\b/)) return "Environmental Services";
  if (text.match(/\b(maintenance|repair)\b/)) return "Facilities Maintenance";

  // Department-based fallbacks
  if (d.includes("transportation") || d.includes("dot")) return "Transportation";
  if (d.includes("health")) return "Healthcare";
  if (d.includes("corrections") || d.includes("rehab")) return "Social & Rehabilitation Services";
  if (d.includes("education")) return "Education";
  if (d.includes("parks") || d.includes("forestry") || d.includes("fish") || d.includes("wildlife")) return "Environmental Services";
  if (d.includes("general services")) return "Facilities Maintenance";
  if (d.includes("technology") || d.includes("statewide stpd")) return "IT Services";
  if (d.includes("military")) return "Public Safety & Emergency";
  if (d.includes("water")) return "Environmental Services";
  if (d.includes("veteran")) return "Healthcare";

  return "Government Services";
}

// Extract estimated value from description if present
function extractEstimatedValue(description: string): string {
  const match = description.match(/\$[\d,]+(?:K|M)?(?:\s*[-–]\s*\$?[\d,]+(?:K|M)?)?/);
  return match ? match[0] : "";
}

// Infer capabilities from title and description using regex patterns
function inferCapabilities(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const caps: string[] = [];

  // IT / Technology
  if (text.match(/\b(cybersecurity|infosec|security\s+assess|penetration|firewall)\b/)) caps.push("Cybersecurity");
  if (text.match(/\b(cloud|aws|azure|gcp|saas|iaas|migration)\b/)) caps.push("Cloud Services");
  if (text.match(/\b(data\s+analytics|analytics|reporting|visualization|dashboard)\b/)) caps.push("Data Analytics");
  if (text.match(/\b(software\s+dev|application\s+dev|custom\s+software|programming)\b/)) caps.push("Software Development");
  if (text.match(/\b(web\s+dev|website|frontend|backend|fullstack)\b/)) caps.push("Web Development");
  if (text.match(/\b(mobile\s+dev|ios|android|flutter)\b/)) caps.push("Mobile Development");
  if (text.match(/\b(database|sql|data\s*base\s+manage)\b/)) caps.push("Database Management");
  if (text.match(/\b(network|lan|wan|fiber|wireless|telecom)\b/)) caps.push("Network Infrastructure");
  if (text.match(/\b(devops|cicd|pipeline|containerization|kubernetes|docker)\b/)) caps.push("DevOps");
  if (text.match(/\b(system\s+integrat|enterprise\s+integrat)\b/)) caps.push("System Integration");
  if (text.match(/\b(ai|artificial\s+intelligence|machine\s+learning|ml\b|neural|nlp)\b/)) caps.push("AI/ML Services");
  if (text.match(/\b(help\s+desk|service\s+desk|it\s+support|tech\s+support)\b/)) caps.push("IT Help Desk & Support");
  if (text.match(/\b(telecommunications|telephone|voip|pbx)\b/)) caps.push("Telecommunications");

  // Construction / Engineering — broadened patterns
  if (text.match(/\b(construction|general\s+contractor|demolition|grading|excavat)\b/)) caps.push("Building Construction");
  if (text.match(/\b(road|highway|paving|asphalt|bridge|pavement|striping|culvert|guardrail|sidewalk|curb|gutter)\b/)) caps.push("Road & Highway Construction");
  if (text.match(/\b(concrete|masonry|foundation|structural|rebar|formwork)\b/)) caps.push("Concrete & Masonry");
  if (text.match(/\b(renovation|remodel|rehabilitat|restoration|retrofit|siding|roofing|roof\s+replace|replace\w*\s+service|upgrade|moderniz)\b/)) caps.push("Renovation & Remodeling");
  if (text.match(/\b(demolition|deconstruct|abate)\b/)) caps.push("Demolition");
  if (text.match(/\b(civil\s+engineer|structural\s+engineer|geotechnical|survey|engineer\w*\s+service)\b/)) caps.push("Civil Engineering");
  if (text.match(/\b(structural\s+engineer|structural\s+analysis|structural\s+design)\b/)) caps.push("Structural Engineering");
  if (text.match(/\b(electrical|wiring|power\s+distribut|lighting|generator|solar|high\s+voltage|switchgear|panel)\b/)) caps.push("Electrical Systems");
  if (text.match(/\b(plumbing|piping|water\s+system|sewer|drain|storm\s*water|catch\s*basin|inlet)\b/)) caps.push("Plumbing & Piping");
  if (text.match(/\b(roofing|roof\s+replace|waterproof|membrane|flashing)\b/)) caps.push("Roofing & Waterproofing");
  if (text.match(/\b(paint|coating|surface\s+prep|blast|primer)\b/)) caps.push("Painting & Coatings");
  if (text.match(/\b(weld|metalwork|fabricat|steel\s+erect)\b/)) caps.push("Welding & Metalwork");
  if (text.match(/\b(heavy\s+equipment|crane|dozer|loader|backhoe|grader)\b/)) caps.push("Heavy Equipment Operation");
  if (text.match(/\b(survey|geotechnical|bore\s+hole|soil\s+test|topograph)\b/)) caps.push("Surveying & Geotechnical");
  if (text.match(/\b(architect|design\s+service|schematic|blueprint)\b/)) caps.push("Architecture & Design");

  // Facilities / Maintenance
  if (text.match(/\b(janitorial|cleaning|custodial|sanitation|housekeeping)\b/)) caps.push("Janitorial & Cleaning");
  if (text.match(/\b(hvac|heating|ventilation|cooling|air\s+balanc|chiller|refrigerat)\b/)) caps.push("HVAC Services");
  if (text.match(/\b(facilit.*maintenance|preventive\s+maintenance|equipment\s+maintenance|repair\s+service|maintenance\s+and\s+repair|repair|replac\w+\s+and\s+repair)\b/)) caps.push("Facilities Maintenance & Repair");
  if (text.match(/\b(landscap|grounds|irrigation|vegetation|horticultur|tree\s+trim)\b/)) caps.push("Landscaping & Grounds");
  if (text.match(/\b(pest\s+control|extermination|fumigat)\b/)) caps.push("Pest Control");
  if (text.match(/\b(waste|refuse|recycl|disposal|trash|garbage|hazardous\s+waste)\b/)) caps.push("Waste Management & Disposal");
  if (text.match(/\b(fire\s+alarm|fire\s+life\s+safety|fire\s+suppression|sprinkler)\b/)) caps.push("Fire & Safety Services");
  if (text.match(/\b(audio|visual|av\s+system|sound\s+system|projector)\b/)) caps.push("Audio/Visual Systems");
  if (text.match(/\b(sign|wayfinding|directory|marquee)\b/)) caps.push("Signage & Wayfinding");
  if (text.match(/\b(furniture|cubicle|workstation|office\s+equip)\b/)) caps.push("Furniture & Office Equipment");

  // Environmental
  if (text.match(/\b(remediat|environmental\s+clean|contamination|hazmat|abatement)\b/)) caps.push("Environmental Remediation");
  if (text.match(/\b(environmental\s+test|environmental\s+monitor|air\s+quality|water\s+quality|soil\s+sample)\b/)) caps.push("Environmental Testing & Monitoring");
  if (text.match(/\b(forestry|vegetation\s+manage|fuel\s+reduction|prescribed\s+burn)\b/)) caps.push("Forestry & Vegetation Management");
  if (text.match(/\b(gis|geographic|mapping|spatial|lidar)\b/)) caps.push("GIS & Mapping");
  if (text.match(/\b(water\s+treatment|wastewater|sewage|water\s+plant)\b/)) caps.push("Water & Wastewater Treatment");
  if (text.match(/\b(tree\s+trim|tree\s+remov|arborist|stump)\b/)) caps.push("Tree Trimming & Removal");
  if (text.match(/\b(hazardous\s+material|hazmat|asbestos|lead\s+paint|mold\s+remediat)\b/)) caps.push("Hazardous Materials Handling");

  // Professional Services
  if (text.match(/\b(consult|advisory|strateg|assessment)\b/)) caps.push("Consulting & Advisory");
  if (text.match(/\b(project\s+manage|program\s+manage|oversight|pmo)\b/)) caps.push("Project Management");
  if (text.match(/\b(quality\s+assur|inspection|testing|calibrat|qa\b)\b/)) caps.push("Quality Assurance");
  if (text.match(/\b(technical\s+writ|transcription|documentation)\b/)) caps.push("Technical Writing");
  if (text.match(/\b(training|workshop|curriculum|instruction|education|course)\b/)) caps.push("Training & Support");
  if (text.match(/\b(staffing|temporary|recruiting|personnel|labor\s+service)\b/)) caps.push("Staffing & Recruiting");
  if (text.match(/\b(accounting|financial|bookkeeping|payroll|audit|budget)\b/)) caps.push("Accounting & Financial Services");
  if (text.match(/\b(legal|attorney|counsel|litigation|investigat)\b/)) caps.push("Legal Services");
  if (text.match(/\b(marketing|advertising|public\s+relations|outreach|communicat)\b/)) caps.push("Communications & Public Relations");
  if (text.match(/\b(translat|interpret|bilingual|multilingual)\b/)) caps.push("Translation & Interpretation");
  if (text.match(/\b(inspect|compliance|code\s+enforce|regulat)\b/)) caps.push("Inspection & Compliance");

  // Transportation & Logistics
  if (text.match(/\b(equipment\s+procure|furnish.*equipment|supply.*equipment|rental)\b/)) caps.push("Equipment Procurement");
  if (text.match(/\b(vehicle|fleet|automotive|towing|truck|tractor)\b/)) caps.push("Vehicle & Fleet Services");
  if (text.match(/\b(courier|delivery|shipping|freight|pick\s*up.*deliver)\b/)) caps.push("Courier & Delivery");
  if (text.match(/\b(logistics|warehouse|storage|inventory|distribution)\b/)) caps.push("Logistics & Warehousing");
  if (text.match(/\b(moving|relocation|movers)\b/)) caps.push("Moving & Relocation");
  if (text.match(/\b(towing|tow\s+service|recovery\s+service)\b/)) caps.push("Towing & Recovery");
  if (text.match(/\b(transit|bus\s+service|shuttle|passenger\s+transport)\b/)) caps.push("Transportation & Transit");

  // Health & Safety
  if (text.match(/\b(medical|clinical|health\s+service|nursing|pharmacy|bio.?hazard)\b/)) caps.push("Medical & Health Services");
  if (text.match(/\b(fire\s+train|live\s+fire|fire\s+alarm|fire\s+life\s+safety|emergency\s+service)\b/)) caps.push("Fire & Safety Services");
  if (text.match(/\b(security\s+guard|armed\s+guard|unarmed\s+guard|patrol|surveillance)\b/)) caps.push("Security Guard Services");
  if (text.match(/\b(emergency\s+manage|disaster|preparedness|continuity)\b/)) caps.push("Emergency Management");
  if (text.match(/\b(social\s+service|outreach|community|case\s+manage)\b/)) caps.push("Social Services & Outreach");

  // Other
  if (text.match(/\b(printing|print\s+service|envelope|publishing)\b/)) caps.push("Printing & Publishing");
  if (text.match(/\b(photo|video|film|record|media\s+product)\b/)) caps.push("Photography & Videography");
  if (text.match(/\b(food\s+service|catering|kitchen|bakery|vending)\b/)) caps.push("Food Services & Catering");
  if (text.match(/\b(fuel|gasoline|diesel|propane|energy\s+supply)\b/)) caps.push("Fuel & Energy Supply");
  if (text.match(/\b(uniform|protective\s+equip|ppe|safety\s+gear)\b/)) caps.push("Uniforms & Protective Equipment");
  if (text.match(/\b(laboratory|lab\s+service|scientific|specimen)\b/)) caps.push("Laboratory & Scientific Services");
  if (text.match(/\b(research|r\s*&\s*d|study|pilot\s+program)\b/)) caps.push("Research & Development");
  if (text.match(/\b(records\s+manage|archiv|document\s+storage|digitiz)\b/)) caps.push("Records Management & Archiving");
  if (text.match(/\b(marine|maritime|harbor|dock|pier)\b/)) caps.push("Marine & Maritime Services");

  // Deduplicate
  return [...new Set(caps)];
}

/**
 * Industry → default capabilities mapping.
 * Used as a last resort when regex finds nothing, so every RFP gets at least
 * one capability for the matching algorithm to work with.
 */
const INDUSTRY_FALLBACK_CAPS: Record<string, string[]> = {
  "Construction":                    ["Building Construction"],
  "Engineering":                     ["Civil Engineering", "Structural Engineering"],
  "IT Services":                     ["Software Development", "Cloud Services"],
  "Facilities Maintenance":          ["Facilities Maintenance & Repair"],
  "Environmental Services":          ["Environmental Testing & Monitoring"],
  "Transportation":                  ["Transportation & Transit"],
  "Equipment & Supplies":            ["Equipment Procurement"],
  "Healthcare":                      ["Medical & Health Services"],
  "Social & Rehabilitation Services":["Social Services & Outreach"],
  "Security":                        ["Security Guard Services"],
  "Public Safety & Emergency":       ["Emergency Management"],
  "Legal Services":                  ["Legal Services"],
  "Food & Agriculture":              ["Food Services & Catering"],
  "Education":                       ["Training & Support"],
  "Consulting":                      ["Consulting & Advisory"],
  "Research & Development":          ["Research & Development"],
  "Manufacturing":                   ["Printing & Publishing"],
  "Real Estate & Leasing":           ["Facilities Maintenance & Repair"],
  "Government Services":             ["Consulting & Advisory"],
};

/**
 * Extract certifications/licenses from RFP text when the structured extraction
 * didn't capture them. Catches contractor licenses, DIR registration, and
 * other professional certifications commonly found in Cal eProcure RFPs.
 */
function extractCertificationsFromText(
  description: string,
  attachmentText?: string,
): string[] {
  const text = `${description}\n${attachmentText || ""}`;
  const certs: string[] = [];
  const seen = new Set<string>();

  const add = (cert: string) => {
    const key = cert.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      certs.push(cert);
    }
  };

  // Contractor's License Class A, B, C, or C-XX patterns
  // Matches: "Class A license", "Class B contractor", "Class C-12", etc.
  const classMatches = text.matchAll(
    /\bClass\s+([A-D](?:-\d{1,2})?)\b(?:\s+(?:license|contractor|general\s+(?:engineering|building)))?/gi
  );
  for (const m of classMatches) {
    const cls = m[1].toUpperCase();
    add(`Contractor's License Class ${cls}`);
  }

  // "C-XX" specialty license codes (e.g. "C-12", "C-36", "C-39")
  const cSpecialtyMatches = text.matchAll(
    /\b(C-\d{1,2})\b/g
  );
  for (const m of cSpecialtyMatches) {
    const code = m[1].toUpperCase();
    if (!seen.has(`contractor's license class ${code.toLowerCase()}`)) {
      add(`Contractor's License Class ${code}`);
    }
  }

  // DIR Registration
  if (/\bDIR\s+(?:registered|registration)\b/i.test(text)) {
    add("DIR Registration");
  }

  // Professional Engineering license
  if (/\bProfessional\s+Engineer(?:ing)?\s+(?:license|PE)\b/i.test(text)) {
    add("Professional Engineer (PE)");
  }

  // Pest Control / Applicator licenses
  if (/\b(?:Pest\s+Control|Structural\s+Pest)\s+(?:license|operator|applicator)\b/i.test(text)) {
    add("Pest Control License");
  }

  // General "contractor's license" or "contractor license required"
  if (certs.length === 0 && /\bcontractor(?:'?s)?\s+license\s+(?:required|is\s+required)\b/i.test(text)) {
    add("Contractor's License");
  }

  return certs;
}

/**
 * Resolve capabilities for an RFP.
 * Strategy: regex-first (based on actual title/description text),
 * with industry-based fallback so every RFP gets at least one capability.
 * LLM-extracted capabilities are NOT used as primary source because
 * the extraction quality is too low (e.g. "Cloud Services" on towing RFPs).
 */
function resolveCapabilities(
  _extraction: AttachmentExtraction | null,
  title: string,
  description: string,
  industry: string,
): string[] {
  // Primary: regex inference from actual title/description text
  const caps = inferCapabilities(title, description);
  if (caps.length > 0) return caps;

  // Fallback: assign default capability based on inferred industry
  const fallback = INDUSTRY_FALLBACK_CAPS[industry];
  if (fallback) return [...fallback];

  return ["Consulting & Advisory"];  // absolute last resort
}

export async function GET() {
  try {
    const loaded = await loadS3Data();
    if (!loaded) {
      return NextResponse.json(
        { error: "Could not load events from S3" },
        { status: 500 }
      );
    }

    const { events, extractions } = loaded;
    const extractionsMap = extractions;
    const extractionCount = Object.keys(extractions).length;
    if (extractionCount > 0) {
      console.log(`Loaded ${extractionCount} attachment extractions`);
    }

    const rfps = events.filter((e) => !!e.title?.trim()).map((e, i) => {
      const extraction = extractionsMap[e.event_id] || null;

      // Use attachment-derived data when available, fall back to inferred
      const naicsCodes = extraction?.naics_codes?.length
        ? extraction.naics_codes
        : ([] as string[]);

      // Use extraction certifications, fall back to text-based detection
      const extractionCerts = extraction?.certifications_required?.length
        ? extraction.certifications_required
        : [];
      const textCerts = extractionCerts.length === 0
        ? extractCertificationsFromText(
            e.description || "",
            extraction?.attachment_text_rollup,
          )
        : [];
      const certifications = extractionCerts.length > 0 ? extractionCerts : textCerts;

      const industry = inferIndustry(e.department || "", e.title, e.description);

      // Regex-first capability resolution with industry fallback
      const capabilities = resolveCapabilities(
        extraction,
        e.title || "",
        e.description || "",
        industry,
      );

      const estimatedValue = extraction?.contract_value_estimate
        || extractEstimatedValue(e.description || "")
        || "TBD";

      const location = extraction?.location_details?.[0]
        || extractLocation(e.title || "", e.description || "", e.department || "");

      // Build attachment rollup for summaries
      const attachmentRollup = extraction
        ? {
            summary: extraction.key_requirements_summary || "",
            text: extraction.attachment_text_rollup || "",
            pdfsProcessed: extraction.pdfs_processed || [],
          }
        : null;

      return {
        id: `event-${i}-${(e.event_id || "unknown").replace(/[/.]/g, "-")}`,
        title: (e.title || "Untitled").replace(/¿/g, "–"),
        agency: e.department || "Unknown Agency",
        location,
        deadline: e.end_date ? e.end_date.replace(/\s+/g, " ").trim() : "",
        estimatedValue,
        industry,
        naicsCodes,
        capabilities,
        certifications,
        contractType: e.format || "RFx",
        description: (e.description || "").slice(0, 2000),
        eventUrl: e.event_url,
        contactName: e.contact_name,
        contactEmail: e.contact_email,
        contactPhone: e.contact_phone,
        // New attachment-derived fields
        clearancesRequired: extraction?.clearances_required || [],
        setAsideTypes: extraction?.set_aside_types || [],
        deliverables: extraction?.deliverables || [],
        contractDuration: extraction?.contract_duration || null,
        evaluationCriteria: extraction?.evaluation_criteria || [],
        attachmentRollup,
      };
    });

    return NextResponse.json(
      { events: rfps, total: rfps.length },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      }
    );
  } catch (err) {
    console.error("Error loading events:", err);
    return NextResponse.json(
      { error: "Failed to load events", details: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
