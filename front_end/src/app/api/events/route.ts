import { NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

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
const S3_BUCKET = process.env.AWS_S3_BUCKET || "civitas-uploads";

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

async function loadAttachmentExtractions(): Promise<Record<string, AttachmentExtraction>> {
  const data = await fetchS3Json<Record<string, AttachmentExtraction>>(
    "scrapes/caleprocure/attachment_extractions.json"
  );
  return data ?? {};
}

// Infer location from description (look for explicit City/County fields first, then pattern match)
function extractLocation(description: string, department: string): string {
  // First: look for explicit "City: X" or "County: X" fields (common in lease & structured RFPs)
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

  // Fallback: look for "X County" pattern in description text
  const counties = [
    "Sacramento", "Los Angeles", "San Francisco", "San Diego", "Orange",
    "Alameda", "Santa Clara", "San Mateo", "Contra Costa", "Riverside",
    "San Bernardino", "Ventura", "Fresno", "Nevada", "Marin",
    "Napa", "Sonoma", "Solano", "Kern", "Tulare", "Monterey", "Santa Cruz"
  ];
  for (const county of counties) {
    if (description.includes(`${county} County`)) {
      return `${county}, CA`;
    }
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

// Infer capabilities from title and description
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

  // Construction / Engineering — broadened patterns to catch typical RFP language
  if (text.match(/\b(construction|general\s+contractor|demolition|grading|excavat)\b/)) caps.push("Building Construction");
  if (text.match(/\b(road|highway|paving|asphalt|bridge|pavement|striping|culvert|guardrail|sidewalk|curb|gutter)\b/)) caps.push("Road & Highway Construction");
  if (text.match(/\b(concrete|masonry|foundation|structural|rebar|formwork)\b/)) caps.push("Concrete & Masonry");
  if (text.match(/\b(renovation|remodel|rehabilitat|restoration|retrofit|siding|roofing|roof\s+replace|replace\w*\s+service|upgrade|moderniz)\b/)) caps.push("Renovation & Remodeling");
  if (text.match(/\b(demolition|deconstruct|abate)\b/)) caps.push("Demolition");
  if (text.match(/\b(civil\s+engineer|structural\s+engineer|geotechnical|survey|engineer\w*\s+service)\b/)) caps.push("Civil Engineering");
  if (text.match(/\b(electrical|wiring|power\s+distribut|lighting|generator|solar|high\s+voltage|switchgear|panel)\b/)) caps.push("Electrical Systems");
  if (text.match(/\b(plumbing|piping|water\s+system|sewer|drain|storm\s*water|catch\s*basin|inlet)\b/)) caps.push("Plumbing & Piping");

  // Facilities / Maintenance
  if (text.match(/\b(janitorial|cleaning|custodial|sanitation|housekeeping)\b/)) caps.push("Janitorial & Cleaning");
  if (text.match(/\b(hvac|heating|ventilation|cooling|air\s+balanc|chiller|refrigerat)\b/)) caps.push("HVAC Services");
  if (text.match(/\b(facilit.*maintenance|preventive\s+maintenance|equipment\s+maintenance|repair\s+service|maintenance\s+and\s+repair|repair|replac\w+\s+and\s+repair)\b/)) caps.push("Facilities Maintenance & Repair");
  if (text.match(/\b(landscap|grounds|irrigation|vegetation|horticultur|tree\s+trim)\b/)) caps.push("Landscaping & Grounds");
  if (text.match(/\b(pest\s+control|extermination|fumigat)\b/)) caps.push("Pest Control");
  if (text.match(/\b(waste|refuse|recycl|disposal|trash|garbage|hazardous\s+waste)\b/)) caps.push("Waste Management & Disposal");

  // Professional Services
  if (text.match(/\b(consult|advisory|strateg|assessment)\b/)) caps.push("Consulting & Advisory");
  if (text.match(/\b(project\s+manage|program\s+manage|oversight|pmo)\b/)) caps.push("Project Management");
  if (text.match(/\b(quality\s+assur|inspection|testing|calibrat|qa\b)\b/)) caps.push("Quality Assurance");
  if (text.match(/\b(technical\s+writ|transcription|documentation)\b/)) caps.push("Technical Writing");
  if (text.match(/\b(training|workshop|curriculum|instruction|education|course)\b/)) caps.push("Training & Support");
  if (text.match(/\b(staffing|temporary|recruiting|personnel|labor\s+service)\b/)) caps.push("Staffing & Recruiting");
  if (text.match(/\b(accounting|financial|bookkeeping|payroll|audit|budget)\b/)) caps.push("Accounting & Financial Services");
  if (text.match(/\b(legal|attorney|counsel|litigation|investigat)\b/)) caps.push("Legal Services");

  // Other
  if (text.match(/\b(equipment\s+procure|furnish.*equipment|supply.*equipment|rental)\b/)) caps.push("Equipment Procurement");
  if (text.match(/\b(vehicle|fleet|automotive|towing|truck|tractor)\b/)) caps.push("Vehicle & Fleet Services");
  if (text.match(/\b(courier|delivery|shipping|freight|pick\s*up.*deliver)\b/)) caps.push("Courier & Delivery");
  if (text.match(/\b(remediat|environmental\s+clean|contamination|hazmat|abatement)\b/)) caps.push("Environmental Remediation");
  if (text.match(/\b(medical|clinical|health\s+service|nursing|pharmacy|bio.?hazard)\b/)) caps.push("Medical & Health Services");
  if (text.match(/\b(fire\s+train|live\s+fire|fire\s+alarm|fire\s+life\s+safety|emergency\s+service)\b/)) caps.push("Fire & Safety Services");
  if (text.match(/\b(printing|print\s+service|envelope|publishing)\b/)) caps.push("Printing & Publishing");

  // Return empty array if nothing matched — Phase 2 will give full points for "no requirement"
  return caps;
}

export async function GET() {
  try {
    const data = await fetchS3Json<{ events: ScrapedEvent[] }>(
      "scrapes/caleprocure/all_events.json"
    );
    if (!data) {
      return NextResponse.json(
        { error: "Could not load events from S3" },
        { status: 500 }
      );
    }

    // Load attachment extractions (empty object if file doesn't exist)
    const extractions = await loadAttachmentExtractions();
    const extractionCount = Object.keys(extractions).length;
    if (extractionCount > 0) {
      console.log(`Loaded ${extractionCount} attachment extractions`);
    }

    const events: ScrapedEvent[] = data.events ?? [];
    const rfps = events.map((e, i) => {
      const extraction = extractions[e.event_id] || null;

      // Use attachment-derived data when available, fall back to inferred
      const naicsCodes = extraction?.naics_codes?.length
        ? extraction.naics_codes
        : ([] as string[]);

      const certifications = extraction?.certifications_required?.length
        ? extraction.certifications_required
        : ([] as string[]);

      const capabilities = extraction?.capabilities_required?.length
        ? extraction.capabilities_required
        : inferCapabilities(e.title || "", e.description || "");

      const estimatedValue = extraction?.contract_value_estimate
        || extractEstimatedValue(e.description || "")
        || "TBD";

      const location = extraction?.location_details?.[0]
        || extractLocation(e.description || "", e.department || "");

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
        industry: inferIndustry(e.department || "", e.title, e.description),
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

    return NextResponse.json({ events: rfps, total: rfps.length });
  } catch (err) {
    console.error("Error loading events:", err);
    return NextResponse.json(
      { error: "Failed to load events", details: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
