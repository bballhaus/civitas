import CAPABILITIES_DATA from "@/data/capabilities.json";

export const CAPABILITIES: readonly string[] = CAPABILITIES_DATA;

export const CAPABILITIES_SET: ReadonlySet<string> = new Set(CAPABILITIES);

/**
 * Broad capability categories for tiered scoring.
 * A company doing "Plumbing & Piping" may not match "HVAC Services" exactly,
 * but both fall under "Construction & Trades" — that's worth partial credit.
 */
export const CAPABILITY_CATEGORIES: Record<string, string[]> = {
  "Information Technology": [
    "AI/ML Services",
    "Cloud Services",
    "Cybersecurity",
    "Data Analytics",
    "Database Management",
    "DevOps",
    "IT Help Desk & Support",
    "Mobile Development",
    "Network Infrastructure",
    "Software Development",
    "System Integration",
    "Telecommunications",
    "Web Development",
  ],
  "Construction & Trades": [
    "Building Construction",
    "Civil Engineering",
    "Concrete & Masonry",
    "Demolition",
    "Electrical Systems",
    "HVAC Services",
    "Painting & Coatings",
    "Plumbing & Piping",
    "Renovation & Remodeling",
    "Road & Highway Construction",
    "Roofing & Waterproofing",
    "Structural Engineering",
    "Welding & Metalwork",
  ],
  "Facilities & Maintenance": [
    "Audio/Visual Systems",
    "Facilities Maintenance & Repair",
    "Fire & Safety Services",
    "Furniture & Office Equipment",
    "Janitorial & Cleaning",
    "Landscaping & Grounds",
    "Pest Control",
    "Signage & Wayfinding",
  ],
  "Professional Services": [
    "Accounting & Financial Services",
    "Architecture & Design",
    "Communications & Public Relations",
    "Consulting & Advisory",
    "Legal Services",
    "Marketing & Advertising",
    "Project Management",
    "Staffing & Recruiting",
    "Technical Writing",
    "Training & Support",
  ],
  "Environmental & Science": [
    "Environmental Remediation",
    "Environmental Testing & Monitoring",
    "Forestry & Vegetation Management",
    "GIS & Mapping",
    "Laboratory & Scientific Services",
    "Research & Development",
    "Surveying & Geotechnical",
    "Water & Wastewater Treatment",
  ],
  "Transportation & Logistics": [
    "Courier & Delivery",
    "Heavy Equipment Operation",
    "Logistics & Warehousing",
    "Marine & Maritime Services",
    "Moving & Relocation",
    "Towing & Recovery",
    "Transportation & Transit",
    "Vehicle & Fleet Services",
  ],
  "Health, Safety & Social": [
    "Emergency Management",
    "Hazardous Materials Handling",
    "Inspection & Compliance",
    "Medical & Health Services",
    "Quality Assurance",
    "Security Guard Services",
    "Social Services & Outreach",
  ],
  "Supplies & Equipment": [
    "Equipment Procurement",
    "Fuel & Energy Supply",
    "Uniforms & Protective Equipment",
    "Waste Management & Disposal",
  ],
  "Media & Communications": [
    "Photography & Videography",
    "Printing & Publishing",
    "Records Management & Archiving",
    "Translation & Interpretation",
  ],
  "Food & Services": [
    "Food Services & Catering",
    "Tree Trimming & Removal",
  ],
};

// Reverse lookup: capability → category name
const _capToCategory = new Map<string, string>();
for (const [category, caps] of Object.entries(CAPABILITY_CATEGORIES)) {
  for (const cap of caps) {
    _capToCategory.set(cap, category);
  }
}

/** Get the broad category for a capability, or null if uncategorized. */
export function getCapabilityCategory(cap: string): string | null {
  return _capToCategory.get(cap) ?? null;
}

/** Tokenize a string into lowercase words. */
function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

/** Jaccard similarity between two word sets. */
function wordJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Keyword → canonical capability mapping.
 * Catches free-form profile descriptions that don't match via substring or Jaccard.
 * E.g. "Roadway and bridge construction" has "roadway" → Road & Highway Construction.
 */
const KEYWORD_TO_CAP: Record<string, string> = {
  // Construction
  roadway: "Road & Highway Construction",
  bridge: "Road & Highway Construction",
  paving: "Road & Highway Construction",
  asphalt: "Road & Highway Construction",
  sidewalk: "Road & Highway Construction",
  curb: "Road & Highway Construction",
  guardrail: "Road & Highway Construction",
  striping: "Road & Highway Construction",
  pavement: "Road & Highway Construction",
  highway: "Road & Highway Construction",
  concrete: "Concrete & Masonry",
  masonry: "Concrete & Masonry",
  foundation: "Concrete & Masonry",
  flatwork: "Concrete & Masonry",
  rebar: "Concrete & Masonry",
  grading: "Building Construction",
  excavation: "Building Construction",
  excavat: "Building Construction",
  demolition: "Demolition",
  renovation: "Renovation & Remodeling",
  remodel: "Renovation & Remodeling",
  retrofit: "Renovation & Remodeling",
  rehabilitation: "Renovation & Remodeling",
  plumbing: "Plumbing & Piping",
  drainage: "Plumbing & Piping",
  stormwater: "Plumbing & Piping",
  sewer: "Plumbing & Piping",
  piping: "Plumbing & Piping",
  electrical: "Electrical Systems",
  wiring: "Electrical Systems",
  hvac: "HVAC Services",
  heating: "HVAC Services",
  ventilation: "HVAC Services",
  roofing: "Roofing & Waterproofing",
  waterproof: "Roofing & Waterproofing",
  painting: "Painting & Coatings",
  coating: "Painting & Coatings",
  welding: "Welding & Metalwork",
  fabricat: "Welding & Metalwork",
  structural: "Structural Engineering",
  geotechnical: "Surveying & Geotechnical",
  surveying: "Surveying & Geotechnical",
  // Facilities
  landscaping: "Landscaping & Grounds",
  irrigation: "Landscaping & Grounds",
  janitorial: "Janitorial & Cleaning",
  custodial: "Janitorial & Cleaning",
  infrastructure: "Civil Engineering",
  municipal: "Civil Engineering",
  // Environmental
  remediation: "Environmental Remediation",
  hazmat: "Hazardous Materials Handling",
  abatement: "Hazardous Materials Handling",
  // Professional
  consulting: "Consulting & Advisory",
  staffing: "Staffing & Recruiting",
  training: "Training & Support",
  // Transportation
  towing: "Towing & Recovery",
  fleet: "Vehicle & Fleet Services",
  courier: "Courier & Delivery",
  logistics: "Logistics & Warehousing",
};

/**
 * Map a free-form capability string to the closest canonical capability.
 * Four-tier matching: exact → substring → keyword → word-overlap Jaccard (≥0.2).
 * Returns null if no reasonable match is found.
 */
export function normalizeCapability(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (!lower) return null;

  // Tier 1: Exact match (case-insensitive)
  for (const cap of CAPABILITIES) {
    if (cap.toLowerCase() === lower) return cap;
  }

  // Tier 2: Substring match — canonical contains raw or raw contains canonical
  for (const cap of CAPABILITIES) {
    const capLower = cap.toLowerCase();
    if (lower.includes(capLower) || capLower.includes(lower)) return cap;
  }

  // Tier 3: Keyword match — any significant word maps to a canonical capability
  const rawTokens = lower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  for (const token of rawTokens) {
    const mapped = KEYWORD_TO_CAP[token];
    if (mapped) return mapped;
  }

  // Tier 4: Word-overlap Jaccard ≥ 0.2 (lowered from 0.3 for better recall)
  const rawWords = words(raw);
  let bestCap: string | null = null;
  let bestScore = 0;
  for (const cap of CAPABILITIES) {
    const capWords = words(cap);
    const score = wordJaccard(rawWords, capWords);
    if (score > bestScore) {
      bestScore = score;
      bestCap = cap;
    }
  }
  if (bestScore >= 0.2 && bestCap) return bestCap;

  return null;
}
