// Shared RFP matching logic for dashboard and RFP detail page
// Pipeline: Hard Disqualifiers → Synonym Expansion → Weighted Scoring → Explanations
import { normalizeCapability, getCapabilityCategory } from "@/lib/capabilities";

export interface CompanyProfile {
  companyName: string;
  industry: string[];
  sizeStatus: string[];
  certifications: string[];
  clearances: string[];
  naicsCodes: string[];
  workCities: string[];
  workCounties: string[];
  capabilities: string[];
  agencyExperience: string[];
  contractTypes: string[];
  contractCount?: number;
  totalPastContractValue?: string;
  pastPerformance?: string;
  strategicGoals?: string;
  technologyStack?: string[];
  maxSingleContractValue?: string;
  pastContracts?: Array<{ title?: string; description?: string; agency?: string; value?: number }>;
  past_contracts?: Array<{ title?: string; description?: string; agency?: string; value?: number }>;
}

export interface RFP {
  id: string;
  title: string;
  agency: string;
  location: string;
  deadline: string;
  estimatedValue: string;
  industry: string;
  naicsCodes: string[];
  capabilities: string[];
  certifications: string[];
  contractType: string;
  description: string;
  eventUrl?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  // Attachment-derived fields (populated when extraction data exists)
  clearancesRequired?: string[];
  setAsideTypes?: string[];
  deliverables?: string[];
  contractDuration?: string | null;
  evaluationCriteria?: string[];
  attachmentRollup?: {
    summary: string;
    text: string;
    pdfsProcessed: string[];
  } | null;
}

export interface ScoreBreakdown {
  category: string;
  points: number;
  maxPoints: number;
  status: "strong" | "partial" | "weak" | "missing" | "neutral";
  detail: string;
  matchedTokens?: string[];
  rfpTokens?: string[];
  profileTokens?: string[];
}

export interface RFPMatch {
  score: number;
  tier: "excellent" | "strong" | "moderate" | "low" | "disqualified";
  disqualified: boolean;
  disqualifiers: string[];
  reasons: string[];
  positiveReasons: string[];
  negativeReasons: string[];
  breakdown: ScoreBreakdown[];
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// --- Preserved terms: important short/compound terms that survive tokenization ---
const PRESERVED_TERMS: [RegExp, string][] = [
  [/\bc\+\+\b/gi, " cplusplus "],
  [/\bc#\b/gi, " csharp "],
  [/\bnode\.js\b/gi, " nodejs "],
  [/\b\.net\b/gi, " dotnet "],
  [/\bai\/ml\b/gi, " ai_ml "],
  [/\bt&m\b/gi, " time_materials "],
  [/\br&d\b/gi, " research_development "],
  [/\bo&m\b/gi, " operations_maintenance "],
  [/\bu\.s\.\b/gi, " us "],
];

function normalizeText(value: string): string {
  let text = value.toLowerCase().trim();
  // Replace preserved compound terms BEFORE stripping punctuation
  for (const [pattern, replacement] of PRESERVED_TERMS) {
    text = text.replace(pattern, replacement);
  }
  // Strip remaining punctuation (preserve underscores for our canonical tokens)
  return text
    .replace(/[^a-z0-9_\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  // Min length 2 (not 3) — preserves "AI", "IT", "ML", "QA", "HR", "UX", "5G"
  return normalized.split(" ").filter((token) => token.length >= 2);
}

function toTokenSet(values: string[]): Set<string> {
  const tokens = values.flatMap((value) => tokenize(value));
  return new Set(tokens);
}

// Stop words for description matching — filtered to prevent high-frequency
// non-domain words from inflating coverage scores. Only used in the description
// matching section, NOT in structured field matching (capabilities, industry, etc.).
const STOP_WORDS = new Set([
  // Articles & determiners
  "the", "an", "this", "that", "these", "those", "each", "every",
  "any", "all", "both", "few", "more", "most", "other", "some", "such", "no",
  // Pronouns
  "it", "its", "they", "them", "their", "we", "our", "you", "your", "he",
  "she", "his", "her", "who", "whom", "which", "what",
  // Prepositions
  "of", "in", "to", "for", "with", "on", "at", "from", "by", "about",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over", "up",
  // Conjunctions
  "and", "but", "or", "nor", "so", "yet", "if", "when", "while",
  "because", "although", "unless", "until", "than",
  // Common verbs (non-domain)
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "shall", "should", "may", "might",
  "can", "could", "must", "need", "get", "make", "made", "let",
  // RFP/procurement boilerplate
  "services", "service", "contractor", "contract", "contracts",
  "provide", "provided", "providing", "required", "requires", "requirement",
  "requirements", "including", "include", "includes", "within", "upon",
  "pursuant", "accordance", "applicable", "appropriate", "ensure",
  "responsible", "related", "also", "per", "not",
  "state", "department", "agency", "work", "proposal",
  // Generic abstract nouns in every RFP
  "management", "information", "based", "following", "described",
  "period", "date", "time", "days", "years", "year",
  "section", "item", "items", "number", "order", "part",
  "total", "amount", "price", "cost",
  // Miscellaneous high-frequency low-signal
  "new", "use", "used", "using", "well", "one", "two", "first",
  "second", "only", "very", "just", "how", "where", "then",
  "there", "here", "now", "way", "own", "same", "able",
]);

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// NAICS overlap — require minimum 4-digit precision for prefix matching
function countNaicsOverlap(rfpCodes: string[], profileCodes: string[]): string[] {
  if (rfpCodes.length === 0 || profileCodes.length === 0) return [];
  const normalizedProfile = profileCodes.map((code) => code.trim());
  return rfpCodes.filter((code) => {
    const trimmed = code.trim();
    return normalizedProfile.some((profileCode) => {
      if (profileCode === trimmed) return true;
      // Prefix matching requires at least 4 digits for the shorter code
      const shorter = profileCode.length <= trimmed.length ? profileCode : trimmed;
      const longer = profileCode.length <= trimmed.length ? trimmed : profileCode;
      if (shorter.length >= 4 && longer.startsWith(shorter)) return true;
      return false;
    });
  });
}

function findTokenOverlap(values: string[], profileTokens: Set<string>): string[] {
  return values.filter((value) => {
    const tokens = tokenize(value);
    return tokens.some((token) => profileTokens.has(token));
  });
}

// Pure linear scoring — no 15% floor (0% similarity = 0 points)
function scoreFromSimilarity(sim: number, maxPoints: number) {
  const s = clamp(sim, 0, 1);
  return maxPoints * s;
}

// ---------------------------------------------------------------------------
// Canonical normalization maps for structured field matching
// ---------------------------------------------------------------------------

const CERTIFICATION_CANONICAL: Record<string, string> = {
  // --- Federal / industry standards ---
  "iso 9001": "iso_9001", "iso-9001": "iso_9001", "iso9001": "iso_9001", "iso 9001:2015": "iso_9001",
  "iso 27001": "iso_27001", "iso-27001": "iso_27001", "iso27001": "iso_27001",
  "soc 2": "soc_2", "soc-2": "soc_2", "soc2": "soc_2", "soc 2 type ii": "soc_2",
  "fedramp": "fedramp", "fed-ramp": "fedramp", "fed ramp": "fedramp",
  "cmmi": "cmmi", "cmmi-dev": "cmmi", "cmmi dev": "cmmi",
  "pci dss": "pci_dss", "pci-dss": "pci_dss", "pcidss": "pci_dss",
  "hipaa": "hipaa", "hipaa compliance": "hipaa",
  "nist 800-53": "nist_800_53", "nist800-53": "nist_800_53", "nist 800 53": "nist_800_53",
  "itar": "itar",
  "gsa schedule": "gsa_schedule", "gsa": "gsa_schedule",
  "naics codes": "naics",

  // --- Small Business (SB) — all variants ---
  "sb": "sb", "small business": "sb", "small business (sb)": "sb",
  "certified sb": "sb", "certified small business": "sb", "small business sb": "sb",
  "california small business": "sb", "california-certified small business (sb)": "sb",
  "california certified small business": "sb", "california certified small business certification": "sb",
  "dgs certified small business (sb)": "sb", "small business preference": "sb",
  "small business preferences": "sb",

  // --- DVBE — all variants ---
  "dvbe": "dvbe", "disabled veteran business enterprise": "dvbe",
  "disabled veteran business enterprise (dvbe)": "dvbe", "disabled veteran business enterprise dvbe": "dvbe",
  "disabled veteran enterprise (dvbe)": "dvbe", "disabled veterans business (dvbe)": "dvbe",
  "disabled veteran business enterprises (dvbe)": "dvbe",
  "disabled veteran business enterprise (dvbe) program participation": "dvbe",
  "disabled veteran business enterprise (dvbe) participation program": "dvbe",
  "disabled veteran business enterprise (dvbe) participation": "dvbe",
  "california certified disabled veteran business": "dvbe",
  "dgs certified disabled veteran business enterprise (dvbe)": "dvbe",
  "dvbe checklist  dpr 479": "dvbe",

  // --- DBE / MBE ---
  "dbe": "dbe", "disadvantaged business enterprise": "dbe", "disadvantaged business enterprise (dbe)": "dbe",
  "mbe": "mbe", "minority business enterprise": "mbe", "minority business enterprise (mbe)": "mbe",

  // --- Micro Business (MB) — all variants ---
  "mb": "mb", "micro business": "mb", "micro business (mb)": "mb", "micro business mb": "mb",
  "microbusiness (mb)": "mb", "micro-business (mb)": "mb", "microbusiness": "mb",
  "dgs certified micro business (mb)": "mb", "micro business (sb/mb)": "mb",

  // --- SB-PW (Small Business for Public Works) — all variants ---
  "sb-pw": "sb_pw", "sbpw": "sb_pw", "california sb-pw": "sb_pw",
  "small business for the purpose of public works (sb-pw)": "sb_pw",
  "small business for the purpose of public works sb-pw": "sb_pw",
  "small business for the purpose of public works sbpw": "sb_pw",
  "small business for the purpose of public works": "sb_pw",
  "sb for the purpose of public works (sb-pw)": "sb_pw",
  "sb for the purpose of public works sbpw": "sb_pw",
  "small business for public works (sb-pw)": "sb_pw",
  "small business for public works": "sb_pw",
  "small business enterprise (sb) for public works (sb-pw)": "sb_pw",
  "dgs certified small business for the purpose of public works (sb-pw)": "sb_pw",
  "dgs-certified small business public works business enterprises": "sb_pw",

  // --- NVSA ---
  "nvsa": "nvsa", "nonprofit veteran service agency (nvsa)": "nvsa",
  "nonprofit veteran service agency": "nvsa",

  // --- DIR (Dept of Industrial Relations) Registration ---
  "dir registration": "dir", "dir": "dir",
  "department of industrial relations registration number": "dir",
  "department of industrial relations registration": "dir",
  "department of industrial relations (dir) registration": "dir",
  "registration with the department of industrial relations (dir)": "dir",
  "dir public works contractor registration": "dir",
  "public works contractor registration": "dir",
  "public works contractor with the department of industrial relations (dir)": "dir",

  // --- Contractor licenses ---
  "contractors license class b": "contractor_b", "contractor's license class b": "contractor_b",
  "california class b - general building contractor's license": "contractor_b",
  "general building contractor": "contractor_b",
  "contractors license class a": "contractor_a",
  "general engineering contractors license (class a)": "contractor_a",
  "general engineering contractor": "contractor_a",
  "a (general engineering) or b (general building)": "contractor_ab",
  "contractor's license class c-39": "contractor_c39",
  "contractor's license class c36": "contractor_c36",
  "c-36 plumbing contractor license": "contractor_c36",

  // --- Compliance certifications ---
  "darfur contracting act certification": "darfur", "darfur contracting act certification  dpr 74": "darfur",
  "sweatfree code of conduct": "sweatfree",
  "california civil rights laws certification": "ca_civil_rights",
  "california business license": "ca_business_license",
  "iran contracting act certification": "iran_contracting", "iran contracting certification": "iran_contracting",

  // --- Combined / composite entries (match the most specific component) ---
  "dgs certified small business (sb)/micro business (mb)/sb for the purpose of public works (sb-pw) or disabled veteran business enterprise (dvbe)": "sb",
  "sb/dvbe certification number": "sb",
};

const SET_ASIDE_CANONICAL: Record<string, string> = {
  "8(a)": "8a", "8a": "8a", "8 a": "8a", "8(a) business": "8a",
  "hubzone": "hubzone", "hub zone": "hubzone",
  "sdvosb": "sdvosb", "service-disabled veteran-owned (sdvosb)": "sdvosb", "service-disabled veteran": "sdvosb", "service disabled veteran": "sdvosb",
  "vosb": "vosb", "veteran-owned small business (vosb)": "vosb", "veteran-owned": "vosb", "veteran owned": "vosb",
  "wosb": "wosb", "women-owned small business (wosb)": "wosb", "women-owned": "wosb", "women owned": "wosb",
  "small business": "small_business", "sb": "small_business", "certified small business": "small_business",
  "sdb": "sdb", "small disadvantaged business (sdb)": "sdb", "small disadvantaged business": "sdb",
  "dvbe": "dvbe", "disabled veterans business enterprise": "dvbe",
  "mbe": "mbe", "minority-owned": "mbe", "minority owned": "mbe", "minority business": "mbe", "mb": "mbe",
  "sb-pw": "small_business", // Small Business - Public Works
};

const CONTRACT_TYPE_CANONICAL: Record<string, string> = {
  "fixed price": "fixed_price", "ffp": "fixed_price", "firm fixed price": "fixed_price",
  "time & materials": "time_materials", "time and materials": "time_materials", "t&m": "time_materials",
  "cost plus": "cost_plus", "cpff": "cost_plus", "cpaf": "cost_plus", "cost plus fixed fee": "cost_plus", "cost plus award fee": "cost_plus",
  "idiq": "idiq", "idiq (indefinite delivery)": "idiq", "indefinite delivery": "idiq",
  "bpa": "bpa", "bpa (blanket purchase agreement)": "bpa", "blanket purchase agreement": "bpa",
  "gsa schedule": "gsa_schedule",
  "competitive": "competitive",
  "sole source": "sole_source",
  "multi-year": "multi_year", "multi year": "multi_year",
  "small business set-aside": "sb_set_aside",
};

function canonicalize(value: string, map: Record<string, string>): string {
  const lower = value.toLowerCase().trim();
  if (map[lower]) return map[lower];
  // Try after stripping punctuation
  const stripped = lower.replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  if (map[stripped]) return map[stripped];
  return lower;
}

function canonicalSetMatch(
  rfpValues: string[],
  profileValues: string[],
  canonicalMap: Record<string, string>
): { ratio: number; matched: string[] } {
  if (rfpValues.length === 0) return { ratio: 1, matched: [] };
  if (profileValues.length === 0) return { ratio: 0, matched: [] };
  const profileCanonical = new Set(profileValues.map((v) => canonicalize(v, canonicalMap)));
  // Deduplicate RFP certs by canonical value to avoid inflating ratio
  // (e.g. "SB" and "Small Business (SB)" are the same requirement)
  const rfpCanonicalSet = new Set(rfpValues.map((v) => canonicalize(v, canonicalMap)));
  const matchedCanonical = [...rfpCanonicalSet].filter((c) => profileCanonical.has(c));
  // Return original labels for display, but ratio based on unique canonical certs
  const matched = rfpValues.filter((v) => profileCanonical.has(canonicalize(v, canonicalMap)));
  return {
    ratio: matchedCanonical.length / Math.max(1, rfpCanonicalSet.size),
    matched,
  };
}

// ---------------------------------------------------------------------------
// Geographic proximity for California locations
// ---------------------------------------------------------------------------

const CA_METRO_GROUPS: Record<string, string[]> = {
  sacramento_metro: ["sacramento", "elk grove", "roseville", "folsom", "rancho cordova", "citrus heights", "davis", "woodland", "west sacramento", "natomas", "carmichael", "fair oaks", "orangevale"],
  bay_area: ["san francisco", "oakland", "san jose", "berkeley", "fremont", "sunnyvale", "santa clara", "palo alto", "mountain view", "redwood city", "hayward", "concord", "walnut creek", "richmond", "daly city", "san mateo", "pleasanton", "livermore", "milpitas", "cupertino", "menlo park"],
  la_metro: ["los angeles", "long beach", "santa monica", "pasadena", "glendale", "burbank", "inglewood", "torrance", "pomona", "el monte", "downey", "norwalk", "compton", "west covina", "baldwin park"],
  san_diego_metro: ["san diego", "chula vista", "oceanside", "escondido", "carlsbad", "el cajon", "vista", "san marcos", "encinitas"],
  central_valley: ["fresno", "bakersfield", "stockton", "modesto", "visalia", "merced", "tulare", "hanford", "madera", "turlock", "clovis", "lodi", "manteca", "tracy"],
  inland_empire: ["riverside", "san bernardino", "ontario", "rancho cucamonga", "fontana", "corona", "moreno valley", "temecula", "murrieta", "redlands", "victorville"],
};

function locationProximityScore(
  rfpLocation: string,
  profileCities: string[],
  profileCounties: string[]
): number {
  if (!rfpLocation?.trim()) return 0;
  const rfpLower = rfpLocation.toLowerCase();
  const profileLocs = [...profileCities, ...profileCounties].map((l) => l.toLowerCase());
  if (profileLocs.length === 0) return 0;

  // Exact or substring match
  if (profileLocs.some((p) => rfpLower.includes(p) || p.includes(rfpLower))) return 1.0;

  // Same metro area
  for (const cities of Object.values(CA_METRO_GROUPS)) {
    const rfpInGroup = cities.some((c) => rfpLower.includes(c));
    const profileInGroup = profileLocs.some((p) => cities.some((c) => p.includes(c) || c.includes(p)));
    if (rfpInGroup && profileInGroup) return 0.75;
  }

  // Both in California
  if (rfpLower.includes("california") || rfpLower.includes(", ca")) return 0.2;

  return 0;
}

// ---------------------------------------------------------------------------
// Domain synonym map — expands tokens so related concepts match
// ---------------------------------------------------------------------------

// Domain synonym groups — each group is a cluster of related terms.
// Any token in a group expands to include all other tokens in that group.
// This is more maintainable than a bidirectional map and ensures full coverage.
const SYNONYM_GROUPS: string[][] = [
  // ── IT / Software ──
  ["cloud", "aws", "azure", "gcp", "saas", "iaas", "paas", "serverless", "hosting"],
  ["software", "application", "platform", "program"],
  ["programming", "coding", "scripting"],
  ["database", "sql", "nosql", "mongodb", "postgresql", "oracle", "mysql", "dynamodb"],
  ["devops", "cicd", "pipeline", "deployment", "containerization", "kubernetes", "docker", "terraform"],
  ["web", "frontend", "backend", "fullstack", "javascript", "react", "angular", "html", "css"],
  ["mobile", "ios", "android", "flutter", "native"],
  ["api", "integration", "interface", "microservices", "rest", "graphql", "webhook"],
  ["erp", "sap", "oracle", "workday", "peoplesoft"],
  ["crm", "salesforce", "dynamics"],

  // ── Cybersecurity ──
  ["cybersecurity", "infosec", "security", "firewall", "encryption", "compliance"],
  ["siem", "splunk", "monitoring", "logging", "detection"],
  ["soc", "incident", "response", "threat", "intelligence"],
  ["penetration", "pentest", "vulnerability", "assessment", "ethical", "hacking"],
  ["zero", "trust", "identity", "access", "authentication", "authorization"],
  ["nist", "fisma", "fedramp", "rmf", "ato"],

  // ── Data / AI / Analytics ──
  ["data", "analytics", "reporting", "visualization", "tableau", "powerbi", "looker"],
  ["warehouse", "etl", "pipeline", "lake", "databricks", "snowflake", "redshift"],
  ["machine", "learning", "model", "prediction", "classification", "regression"],
  ["artificial", "intelligence", "neural", "deep", "nlp", "llm", "generative"],
  ["forecast", "statistical", "analysis", "modeling"],

  // ── Construction / Capital ──
  ["construction", "building", "demolition", "renovation", "grading", "pavement", "excavation"],
  ["renovation", "remodel", "rehabilitation", "restoration", "retrofit"],
  ["roofing", "waterproofing", "insulation", "siding", "exterior"],
  ["concrete", "masonry", "steel", "structural", "foundation"],
  ["paving", "asphalt", "road", "highway", "bridge", "infrastructure"],

  // ── Engineering ──
  ["civil", "structural", "geotechnical"],
  ["architect", "architectural", "blueprint"],
  ["survey", "surveying", "topographic"],
  ["drafting", "cad", "autocad", "revit", "bim"],

  // ── Facilities / Maintenance ──
  ["facilities", "maintenance", "repair", "upkeep", "preventive", "corrective"],
  ["janitorial", "cleaning", "custodial", "sanitation", "housekeeping"],
  ["landscaping", "grounds", "irrigation", "vegetation", "outdoor", "horticulture"],
  ["hvac", "heating", "ventilation", "cooling", "mechanical", "climate"],
  ["plumbing", "piping", "water", "sewer", "drainage"],
  ["electrical", "wiring", "power", "lighting", "generator", "solar", "energy"],
  ["elevator", "escalator", "conveyance", "lift"],
  ["pest_control", "extermination", "fumigation"],
  ["waste", "refuse", "recycling", "disposal", "trash", "hazardous"],

  // ── Fleet / Transportation ──
  ["vehicle", "fleet", "automotive", "motor"],
  ["bus", "truck", "transit", "transportation", "shuttle", "freight"],
  ["charging", "electric", "station", "battery"],
  ["logistics", "shipping", "delivery", "distribution", "warehousing", "supply", "chain"],

  // ── Professional Services ──
  ["consulting", "advisory", "strategy", "assessment", "analysis", "recommendation"],
  ["management", "project", "program", "coordination", "oversight", "pmo"],
  ["staffing", "temporary", "augmentation", "resource", "recruiting", "labor", "personnel"],
  ["audit", "compliance", "risk", "regulatory", "governance"],
  ["legal", "attorney", "counsel", "litigation", "arbitration"],
  ["accounting", "financial", "bookkeeping", "payroll", "budgeting"],

  // ── Training / Education ──
  ["training", "workshop", "curriculum", "instruction", "education", "course", "learning", "certification"],
  ["elearning", "lms", "virtual", "classroom", "webinar", "online"],

  // ── Healthcare / Social Services ──
  ["healthcare", "medical", "clinical", "patient", "hospital", "nursing", "pharmacy"],
  ["behavioral", "mental_health", "psychology", "counseling", "therapy"],
  ["social_services", "outreach", "community"],
  ["hipaa", "ehr", "emr", "health_informatics"],

  // ── Supplies / Equipment ──
  ["supply", "supplies", "equipment", "materials", "parts", "furnish", "procurement", "hardware"],
  ["furniture", "office", "workspace", "ergonomic", "modular"],
  ["uniform", "clothing", "protective", "ppe", "safety", "gear"],

  // ── Telecom / Network ──
  ["network", "infrastructure", "wan", "lan", "fiber", "wireless", "telecom", "telecommunications"],
  ["voip", "pbx", "telephone", "communications", "unified"],
  ["cable", "cabling", "structured", "fiber", "optic"],

  // ── Environmental / Scientific ──
  ["environmental", "remediation", "abatement", "contamination", "hazmat"],
  ["testing", "laboratory", "inspection", "quality", "assurance", "calibration"],
  ["research", "development", "scientific", "study", "investigation"],

  // ── Certifications (abbreviation ↔ full name, kept tight to avoid false matches) ──
  ["iso9001", "iso_9001"],
  ["iso27001", "iso_27001"],
  ["cmmi", "capability_maturity"],
  ["pci", "dss", "pci_dss"],
  ["soc2", "soc_2"],
  ["itar", "export_control"],
  ["gsa", "gsa_schedule"],
];

// Build a fast lookup map from the groups
const SYNONYM_MAP: Record<string, Set<string>> = {};
for (const group of SYNONYM_GROUPS) {
  for (const term of group) {
    if (!SYNONYM_MAP[term]) {
      SYNONYM_MAP[term] = new Set<string>();
    }
    for (const other of group) {
      if (other !== term) {
        SYNONYM_MAP[term].add(other);
      }
    }
  }
}

// Optional fallback: use the `synonyms` npm package for general English words
// not covered by domain groups. Filter to noun senses only to avoid noise.
let _synonymsLib: ((word: string) => Record<string, string[]> | null) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _synonymsLib = require("synonyms");
} catch {
  // Package not available — domain map only
}

// Memoize synonym lookups — same token appears across many RFPs, avoids redundant work
const _synonymCache = new Map<string, Set<string>>();
const SYNONYM_CACHE_MAX = 500;

function getSynonyms(token: string): Set<string> {
  const cached = _synonymCache.get(token);
  if (cached !== undefined) return cached;

  const domain = SYNONYM_MAP[token];
  if (domain && domain.size > 0) {
    if (_synonymCache.size < SYNONYM_CACHE_MAX) _synonymCache.set(token, domain);
    return domain;
  }

  let result: Set<string> = new Set();
  if (_synonymsLib) {
    const SKIP = new Set(["system", "group", "unit", "part", "point", "line", "set", "body", "field", "plan", "area", "order", "form"]);
    if (!SKIP.has(token)) {
      const libResult = _synonymsLib(token);
      if (libResult?.n) {
        const nouns = libResult.n.filter((s: string) => s !== token && s.length > 2 && !SKIP.has(s));
        if (nouns.length > 0) result = new Set(nouns.slice(0, 6));
      }
    }
  }
  if (_synonymCache.size < SYNONYM_CACHE_MAX) _synonymCache.set(token, result);
  return result;
}

// Generic terms that should NOT be expanded via synonyms (too broad, cause false positives)
const STOP_EXPANSION = new Set([
  "development", "management", "services", "support", "system", "systems",
  "solution", "solutions", "general", "operations", "process", "design",
  "analysis", "planning", "implementation", "service", "project",
]);

// Cache expanded token sets — profile tokens are identical across all RFPs
const _expandCache = new Map<string, Set<string>>();
const EXPAND_CACHE_MAX = 200;

function expandWithSynonyms(tokens: Set<string>): Set<string> {
  const key = [...tokens].sort().join("|");
  const cached = _expandCache.get(key);
  if (cached !== undefined) return cached;

  const expanded = new Set(tokens);
  for (const token of tokens) {
    if (STOP_EXPANSION.has(token)) continue;
    const synonyms = getSynonyms(token);
    for (const syn of synonyms) {
      expanded.add(syn);
    }
  }
  if (_expandCache.size < EXPAND_CACHE_MAX) _expandCache.set(key, expanded);
  return expanded;
}

// ---------------------------------------------------------------------------
// Agency alias expansion — maps abbreviations/short names to full department names
// ---------------------------------------------------------------------------
const AGENCY_ALIAS_GROUPS: string[][] = [
  ["caltrans", "department of transportation", "calif department of transportation", "ca dept of transportation", "dot"],
  ["dgs", "department of general services", "ca dept of general services", "calif department of general services"],
  ["cdcr", "department of corrections & rehabilitation", "department of corrections and rehabilitation", "dept of corrections & rehab", "corrections"],
  ["calfire", "department of forestry and fire protection", "cal fire"],
  ["edd", "employment development department", "employment development dept"],
  ["dmv", "department of motor vehicles"],
  ["dwr", "department of water resources"],
  ["dtsc", "department of toxic substances control"],
  ["cdfw", "department of fish & wildlife", "department of fish and wildlife", "dept of fish & wildlife"],
  ["cdph", "department of public health", "calif department of public health"],
  ["dpr", "department of parks & recreation", "department of parks and recreation", "dept of parks & recreation"],
  ["cde", "department of education", "calif department of education"],
  ["hcd", "department of housing and community development", "housing & community development"],
  ["dva", "department of veterans affairs", "calif department of veterans affairs"],
  ["dof", "department of finance"],
  ["dss", "department of social services"],
  ["dhcs", "department of health care services"],
  ["abc", "department of alcoholic beverage control"],
  ["fth", "franchise tax board", "ftb"],
  ["uc", "university of california"],
  ["csu", "california state university"],
  ["public works", "dept of public works", "department of public works"],
];

function expandAgencyAliases(agencyLower: string): string[] {
  const aliases: string[] = [];
  for (const group of AGENCY_ALIAS_GROUPS) {
    if (group.some((alias) => agencyLower.includes(alias) || alias.includes(agencyLower))) {
      for (const alias of group) {
        if (alias !== agencyLower) aliases.push(alias);
      }
    }
  }
  return aliases;
}

function synonymAwareJaccard(a: Set<string>, b: Set<string>): number {
  const expandedA = expandWithSynonyms(a);
  const expandedB = expandWithSynonyms(b);
  return jaccardSimilarity(expandedA, expandedB);
}

function synonymAwareOverlap(values: string[], profileTokens: Set<string>): string[] {
  const expandedProfile = expandWithSynonyms(profileTokens);
  return values.filter((value) => {
    const tokens = tokenize(value);
    const expandedValue = expandWithSynonyms(new Set(tokens));
    for (const t of expandedValue) {
      if (expandedProfile.has(t)) return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Contract value parsing
// ---------------------------------------------------------------------------

function parseContractValue(value: string): number | null {
  const v = (value || "").trim();
  if (!v || v.toUpperCase() === "TBD" || v.toUpperCase() === "UNKNOWN") return null;

  const parseSingle = (numStr: string, suffix: string | undefined): number => {
    let num = parseFloat(numStr);
    const s = (suffix || "").toLowerCase();
    if (s === "k") num *= 1_000;
    else if (s === "m") num *= 1_000_000;
    else if (s === "b") num *= 1_000_000_000;
    return num;
  };

  // Try range patterns: "$5-10M", "$5M-$10M", "$100K - $500K"
  const rangeMatch = v.match(
    /\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|b)?\s*[-–to]+\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|b)?/i
  );
  if (rangeMatch) {
    const low = parseSingle(rangeMatch[1].replace(/,/g, ""), rangeMatch[2]);
    const high = parseSingle(rangeMatch[3].replace(/,/g, ""), rangeMatch[4] || rangeMatch[2]); // inherit suffix
    return Math.max(low, high);
  }

  // Single value: "$1.5M", "$1,500,000", "1500K"
  const cleaned = v.replace(/[$,\s]/g, "").toLowerCase();
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(k|m|b)?/);
  if (!match) return null;
  return parseSingle(match[1], match[2]);
}

// ---------------------------------------------------------------------------
// Deadline parsing
// ---------------------------------------------------------------------------

export function parseDeadline(deadline: string): Date | null {
  const normalized = deadline?.trim();
  if (!normalized || normalized.toUpperCase() === "TBD") return null;

  const direct = Date.parse(normalized);
  if (!Number.isNaN(direct)) return new Date(direct);

  const cleaned = normalized
    .replace(/\b(PST|PDT)\b/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const m = cleaned.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)$/i
  );
  if (!m) return null;

  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  let hh = Number(m[4]);
  const ampm = m[6].toUpperCase();

  if (ampm === "PM" && hh !== 12) hh += 12;
  if (ampm === "AM" && hh === 12) hh = 0;

  return new Date(yyyy, mm - 1, dd, hh, Number(m[5]), 0);
}

// ---------------------------------------------------------------------------
// Set-aside / small business detection
// ---------------------------------------------------------------------------

const SET_ASIDE_PATTERNS = [
  { label: "8(a)", pattern: /\b8\s*\(?a\)?\b/i },
  { label: "HUBZone", pattern: /\bhubzone\b/i },
  { label: "SDVOSB", pattern: /\b(sdvosb|service[- ]disabled\s+veteran)/i },
  { label: "VOSB", pattern: /\bvosb|veteran[- ]owned/i },
  { label: "WOSB", pattern: /\b(wosb|women[- ]owned)/i },
  { label: "Small Business", pattern: /\bsmall\s+business\s+set[- ]aside/i },
  { label: "SDB", pattern: /\b(sdb|small\s+disadvantaged\s+business)/i },
  { label: "MBE", pattern: /\b(mbe|minority[- ]owned|minority\s+business)/i },
];

function detectSetAsides(text: string): string[] {
  const found: string[] = [];
  for (const { label, pattern } of SET_ASIDE_PATTERNS) {
    if (pattern.test(text)) {
      found.push(label);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Clearance detection
// ---------------------------------------------------------------------------

const CLEARANCE_LEVELS = [
  { label: "TS/SCI", pattern: /\bts\s*\/?\s*sci\b/i, level: 4 },
  { label: "Top Secret", pattern: /\btop\s+secret\b/i, level: 3 },
  { label: "Secret", pattern: /\bsecret\b/i, level: 2 },
  { label: "Public Trust", pattern: /\bpublic\s+trust\b/i, level: 1 },
];

function detectRequiredClearance(text: string): { label: string; level: number } | null {
  for (const cl of CLEARANCE_LEVELS) {
    if (cl.pattern.test(text)) return { label: cl.label, level: cl.level };
  }
  return null;
}

function getProfileClearanceLevel(clearances: string[]): number {
  let maxLevel = 0;
  for (const c of clearances) {
    for (const cl of CLEARANCE_LEVELS) {
      if (cl.pattern.test(c) && cl.level > maxLevel) {
        maxLevel = cl.level;
      }
    }
  }
  return maxLevel;
}

// ---------------------------------------------------------------------------
// Main matching pipeline
// ---------------------------------------------------------------------------

export function computeMatch(rfp: RFP, profile: CompanyProfile | null): RFPMatch {
  const positiveReasons: string[] = [];
  const negativeReasons: string[] = [];
  const disqualifiers: string[] = [];
  const breakdown: ScoreBreakdown[] = [];

  if (!profile) {
    return {
      score: 50,
      tier: "moderate",
      disqualified: false,
      disqualifiers: [],
      reasons: ["Complete your profile for personalized match scores"],
      positiveReasons: [],
      negativeReasons: [],
      breakdown: [],
    };
  }

  // =========================================================================
  // STAGE 1: Hard Disqualifiers (pass/fail gates)
  // =========================================================================

  // Build full text including attachment-derived fields for broader matching
  const deliverableText = (rfp.deliverables ?? []).join(" ");
  const rfpFullText = `${rfp.title} ${rfp.description} ${(rfp.capabilities || []).join(" ")} ${(rfp.certifications || []).join(" ")} ${deliverableText} ${rfp.attachmentRollup?.summary ?? ""}`;

  // 1a. Deadline check — disabled for demo purposes
  const due = parseDeadline(rfp.deadline);

  // 1b. Required clearances — check both text-based detection AND attachment-derived data
  const requiredClearance = detectRequiredClearance(rfpFullText);
  const attachmentClearances = rfp.clearancesRequired ?? [];
  // Also check attachment-derived clearances against our patterns
  let effectiveClearance = requiredClearance;
  if (!effectiveClearance && attachmentClearances.length > 0) {
    const attachClearanceText = attachmentClearances.join(" ");
    effectiveClearance = detectRequiredClearance(attachClearanceText);
  }
  if (effectiveClearance) {
    const profileLevel = getProfileClearanceLevel(profile.clearances ?? []);
    if (profileLevel < effectiveClearance.level) {
      disqualifiers.push(
        `Requires ${effectiveClearance.label} clearance which is not in your profile.`
      );
    }
  }

  // 1c. Set-aside requirements — combine text-detected and attachment-derived
  // Treat as OR: company must meet at least ONE set-aside requirement (not all)
  const textSetAsides = detectSetAsides(rfpFullText);
  const attachmentSetAsides = rfp.setAsideTypes ?? [];
  const rfpSetAsides = [...new Set([...textSetAsides, ...attachmentSetAsides])];
  if (rfpSetAsides.length > 0) {
    const profileCanonical = [
      ...(profile.sizeStatus ?? []).map((s) => canonicalize(s, SET_ASIDE_CANONICAL)),
      ...(profile.certifications ?? []).map((c) => canonicalize(c, SET_ASIDE_CANONICAL)),
    ];
    const met = rfpSetAsides.filter((sa) => {
      const saCanonical = canonicalize(sa, SET_ASIDE_CANONICAL);
      return profileCanonical.includes(saCanonical);
    });
    if (met.length === 0) {
      disqualifiers.push(
        `Set-aside requirement: ${rfpSetAsides.join(" or ")}. Your profile does not indicate any qualifying status.`
      );
    }
  }

  // If disqualified, return early with score 0
  if (disqualifiers.length > 0) {
    const reasons = disqualifiers.map((d) => `✗ ${d}`);
    return {
      score: 0,
      tier: "disqualified",
      disqualified: true,
      disqualifiers,
      reasons,
      positiveReasons: [],
      negativeReasons: disqualifiers,
      breakdown: disqualifiers.map((d) => ({
        category: "Eligibility",
        points: 0,
        maxPoints: 0,
        status: "missing" as const,
        detail: d,
      })),
    };
  }

  // =========================================================================
  // STAGE 2: Build token sets with synonym expansion
  // =========================================================================

  const profileNaics = profile.naicsCodes ?? [];
  const profileCapsTokens = toTokenSet(profile.capabilities ?? []);
  const profileCertTokens = toTokenSet(profile.certifications ?? []);
  const profileAgencyTokens = toTokenSet(profile.agencyExperience ?? []);
  // (Contract type scoring removed — CaleProcure only provides generic format labels)
  const profileLocationTokens = toTokenSet([
    ...(profile.workCities ?? []),
    ...(profile.workCounties ?? []),
  ]);
  const profileIndustryTokens = toTokenSet(profile.industry ?? []);

  const rfpIndustryTokens = toTokenSet([rfp.industry ?? ""]);
  const rfpCapTokens = toTokenSet(rfp.capabilities ?? []);
  const rfpAgencyTokens = toTokenSet([rfp.agency ?? ""]);
  // rfpContractTokens removed (contract type scoring removed)
  const rfpLocationTokens = toTokenSet([rfp.location ?? ""]);
  const rfpDescTokens = toTokenSet([
    rfp.description ?? "",
    rfp.title ?? "",
    ...(rfp.deliverables ?? []),
    rfp.attachmentRollup?.summary ?? "",
  ]);

  // =========================================================================
  // STAGE 3: Weighted Scoring with Normalization
  // =========================================================================
  // Weights: Capabilities 25, Description 20, Industry 15, NAICS 15,
  //          Location 10, Certifications 10, Agency 5
  // Score normalization: only count categories where RFP has data.
  // Categories with no RFP data are "neutral" (excluded from denominator).

  let earnedPoints = 0;
  let maxAchievablePoints = 0;

  // --- Capabilities (max 25 pts) ---
  const CAP_MAX = 25;
  if ((rfp.capabilities ?? []).length > 0) {
    maxAchievablePoints += CAP_MAX;

    // Normalize both sides to canonical capabilities
    const profileCanonCaps = new Set<string>();
    for (const cap of (profile.capabilities ?? [])) {
      const norm = normalizeCapability(cap);
      if (norm) profileCanonCaps.add(norm);
    }
    const rfpCanonCaps = new Set<string>();
    for (const cap of (rfp.capabilities ?? [])) {
      const norm = normalizeCapability(cap);
      if (norm) rfpCanonCaps.add(norm);
    }

    // Exact canonical matches
    const exactMatches: string[] = [];
    for (const cap of rfpCanonCaps) {
      if (profileCanonCaps.has(cap)) exactMatches.push(cap);
    }

    // Category-tiered matches (same category, different capability = 0.3x credit)
    let categoryCredit = 0;
    if (exactMatches.length < rfpCanonCaps.size) {
      const profileCategories = new Set<string>();
      for (const cap of profileCanonCaps) {
        const cat = getCapabilityCategory(cap);
        if (cat) profileCategories.add(cat);
      }
      for (const cap of rfpCanonCaps) {
        if (profileCanonCaps.has(cap)) continue; // already counted as exact
        const cat = getCapabilityCategory(cap);
        if (cat && profileCategories.has(cat)) categoryCredit += 0.3;
      }
    }

    // Also fall back to synonym-aware token matching for non-canonical terms
    const tokenSimilarity = synonymAwareJaccard(rfpCapTokens, profileCapsTokens);

    // Combine: canonical match ratio + category credit + token fallback floor
    const canonRatio = rfpCanonCaps.size > 0
      ? (exactMatches.length + categoryCredit) / rfpCanonCaps.size
      : 0;
    const effectiveRatio = Math.max(canonRatio, tokenSimilarity);
    const pts = scoreFromSimilarity(clamp(effectiveRatio, 0, 1), CAP_MAX);
    earnedPoints += pts;

    if (pts > 0) {
      const matchNames = exactMatches.slice(0, 3).join(", ");
      const detail = matchNames
        ? `Capabilities align: ${matchNames}`
        : "Capabilities align with your profile.";
      positiveReasons.push(detail);
      breakdown.push({ category: "Capabilities", points: Math.round(pts), maxPoints: CAP_MAX, status: pts >= CAP_MAX * 0.7 ? "strong" : "partial", detail, matchedTokens: exactMatches, rfpTokens: rfp.capabilities ?? [], profileTokens: profile.capabilities ?? [] });
    } else {
      negativeReasons.push("Limited capability overlap with your profile.");
      breakdown.push({ category: "Capabilities", points: 0, maxPoints: CAP_MAX, status: "missing", detail: "No capability overlap detected.", rfpTokens: rfp.capabilities ?? [], profileTokens: profile.capabilities ?? [] });
    }
  } else {
    breakdown.push({ category: "Capabilities", points: 0, maxPoints: CAP_MAX, status: "neutral", detail: "RFP does not specify required capabilities.", rfpTokens: [], profileTokens: profile.capabilities ?? [] });
  }

  // --- Industry (max 15 pts) ---
  const IND_MAX = 15;
  if ((rfp.industry ?? "").trim()) {
    maxAchievablePoints += IND_MAX;

    // Substring/inclusion check: "Construction" in profile matches "Construction" in RFP
    const rfpInd = (rfp.industry ?? "").toLowerCase().trim();
    const profileInds = (profile.industry ?? []).map(i => i.toLowerCase().trim());
    const industrySubstringMatch = profileInds.some(pi =>
      rfpInd.includes(pi) || pi.includes(rfpInd)
    );

    if (industrySubstringMatch) {
      earnedPoints += IND_MAX;
      positiveReasons.push("Industry aligns with your profile.");
      breakdown.push({ category: "Industry", points: IND_MAX, maxPoints: IND_MAX, status: "strong", detail: "Industry match found.", rfpTokens: [rfp.industry], profileTokens: profile.industry ?? [] });
    } else {
      // Fall back to token-based Jaccard for partial matches
      const industrySimilarity = synonymAwareJaccard(rfpIndustryTokens, profileIndustryTokens);
      if (industrySimilarity > 0) {
        const pts = scoreFromSimilarity(industrySimilarity, IND_MAX);
        earnedPoints += pts;
        positiveReasons.push("Industry partially aligns with your profile.");
        breakdown.push({ category: "Industry", points: Math.round(pts), maxPoints: IND_MAX, status: "partial", detail: "Partial industry match.", rfpTokens: [rfp.industry], profileTokens: profile.industry ?? [] });
      } else {
        negativeReasons.push(`Industry (${rfp.industry}) not reflected in your profile.`);
        breakdown.push({ category: "Industry", points: 0, maxPoints: IND_MAX, status: "weak", detail: `Industry "${rfp.industry}" not in your profile.`, rfpTokens: [rfp.industry], profileTokens: profile.industry ?? [] });
      }
    }
  } else {
    breakdown.push({ category: "Industry", points: 0, maxPoints: IND_MAX, status: "neutral", detail: "RFP does not specify an industry.", rfpTokens: [], profileTokens: profile.industry ?? [] });
  }

  // --- NAICS Codes (max 15 pts) ---
  const NAICS_MAX = 15;
  const naicsOverlap = countNaicsOverlap(rfp.naicsCodes ?? [], profileNaics);
  if ((rfp.naicsCodes ?? []).length > 0) {
    maxAchievablePoints += NAICS_MAX;
    if (naicsOverlap.length > 0) {
      const ratio = naicsOverlap.length / Math.max(1, rfp.naicsCodes.length);
      const pts = NAICS_MAX * ratio;
      earnedPoints += pts;
      positiveReasons.push(`NAICS overlap: ${naicsOverlap.slice(0, 3).join(", ")}`);
      breakdown.push({ category: "NAICS Codes", points: Math.round(pts), maxPoints: NAICS_MAX, status: ratio >= 0.75 ? "strong" : "partial", detail: `${naicsOverlap.length}/${rfp.naicsCodes.length} codes match.`, matchedTokens: naicsOverlap, rfpTokens: rfp.naicsCodes, profileTokens: profileNaics });
    } else {
      negativeReasons.push("No NAICS code overlap.");
      breakdown.push({ category: "NAICS Codes", points: 0, maxPoints: NAICS_MAX, status: "missing", detail: "None of the RFP's NAICS codes match your profile.", rfpTokens: rfp.naicsCodes, profileTokens: profileNaics });
    }
  } else {
    // Neutral — don't penalize, don't count toward denominator
    breakdown.push({ category: "NAICS Codes", points: 0, maxPoints: 0, status: "neutral", detail: "RFP does not list NAICS codes.", rfpTokens: [], profileTokens: profileNaics });
  }

  // --- Description / Title text match (max 20 pts) ---
  // This is the "specificity" category: captures granular project details
  // (e.g. "lamppost", "guardrail", "storm drain") beyond broad capability labels.
  // Past contract experience tokens get extra weight so companies with relevant
  // project history score higher on matching RFPs.
  const DESC_MAX = 20;
  maxAchievablePoints += DESC_MAX; // Description always counts (always has text)

  const profileCompanyTokens = profile.companyName
    ? new Set(tokenize(profile.companyName).filter((t) => !STOP_WORDS.has(t)))
    : new Set<string>();
  const profileTechTokens = (profile.technologyStack ?? []).length > 0
    ? new Set(profile.technologyStack!.flatMap((t) => tokenize(t)).filter((t) => !STOP_WORDS.has(t)))
    : new Set<string>();

  // Past contract tokens — specific project experience keywords
  const pastContractTokens = new Set<string>();
  for (const contract of (profile.pastContracts ?? profile.past_contracts ?? [])) {
    const title = contract.title ?? "";
    const desc = contract.description ?? "";
    for (const t of tokenize(`${title} ${desc}`)) {
      if (!STOP_WORDS.has(t) && t.length > 2) pastContractTokens.add(t);
    }
  }

  // Free-form capability text tokens (not just canonical labels but the raw text)
  // e.g. "ADA sidewalk and curb ramp installation" → ["ada", "sidewalk", "curb", "ramp", "installation"]
  const rawCapTokens = new Set<string>();
  for (const cap of (profile.capabilities ?? [])) {
    for (const t of tokenize(cap)) {
      if (!STOP_WORDS.has(t) && t.length > 2) rawCapTokens.add(t);
    }
  }

  // Combined "specific experience" tokens (past contracts + raw capabilities)
  // These are the granular terms that go beyond broad category labels.
  const specificTokens = new Set<string>([...pastContractTokens, ...rawCapTokens]);

  const profileTextTokens = new Set<string>([
    ...expandWithSynonyms(profileIndustryTokens),
    ...expandWithSynonyms(profileCapsTokens),
    ...expandWithSynonyms(profileCertTokens),
    ...profileAgencyTokens,
    ...profileCompanyTokens,
    ...expandWithSynonyms(profileTechTokens),
    ...pastContractTokens,
  ]);
  const profileTextFiltered = new Set([...profileTextTokens].filter((t) => !STOP_WORDS.has(t)));
  const rfpDescFiltered = new Set([...rfpDescTokens].filter((t) => !STOP_WORDS.has(t)));

  // General text overlap (geometric mean of forward + reverse coverage)
  const descOverlapTokens = [...profileTextFiltered].filter((t) => rfpDescFiltered.has(t));
  const descCoverage = descOverlapTokens.length / Math.max(1, profileTextFiltered.size);
  const rfpInProfile = [...rfpDescFiltered].filter((t) => profileTextFiltered.has(t));
  const reverseCoverage = rfpInProfile.length / Math.max(1, rfpDescFiltered.size);
  const descRelevance = Math.sqrt(descCoverage * reverseCoverage);
  const descJaccard = jaccardSimilarity(rfpDescFiltered, profileTextFiltered);
  const generalDescScore = Math.max(descRelevance, descJaccard);

  // Specificity bonus: how many of the company's specific project terms appear in the RFP?
  // e.g. "lamppost", "guardrail", "storm drain", "curb ramp" from past contracts
  // This rewards precise experience matches beyond broad capability categories.
  let specificityScore = 0;
  const specificMatches: string[] = [];
  if (specificTokens.size > 0 && rfpDescFiltered.size > 0) {
    for (const t of specificTokens) {
      if (rfpDescFiltered.has(t)) specificMatches.push(t);
    }
    // Ratio of specific terms found in RFP (capped at 1.0)
    // Use sqrt to reward even a few matches — 3 specific matches out of 20 terms
    // should still be meaningful (sqrt(3/20) ≈ 0.39)
    specificityScore = Math.sqrt(specificMatches.length / Math.max(1, specificTokens.size));
  }

  // Blend: 60% general text overlap + 40% specificity bonus
  const descScore = generalDescScore * 0.6 + specificityScore * 0.4;

  if (descScore > 0.01) {
    const pts = scoreFromSimilarity(Math.min(descScore * 2.5, 1), DESC_MAX);
    earnedPoints += pts;
    const specificDetail = specificMatches.length > 0
      ? `Specific experience matches: ${specificMatches.slice(0, 4).join(", ")}.`
      : "Description language matches your profile keywords.";
    positiveReasons.push(specificDetail);
    const descMatched = [...rfpDescTokens].filter(t => profileTextTokens.has(t));
    breakdown.push({ category: "Description Match", points: Math.round(pts), maxPoints: DESC_MAX, status: pts >= DESC_MAX * 0.6 ? "strong" : "partial", detail: specificDetail, matchedTokens: [...new Set([...specificMatches, ...descMatched])].slice(0, 10), rfpTokens: [...rfpDescTokens].slice(0, 15), profileTokens: [...specificTokens].slice(0, 15) });
  } else {
    breakdown.push({ category: "Description Match", points: 0, maxPoints: DESC_MAX, status: "weak", detail: "Minimal keyword overlap between RFP description and your profile.", rfpTokens: [...rfpDescTokens].slice(0, 15), profileTokens: [...specificTokens].slice(0, 15) });
  }

  // --- Location (max 10 pts) ---
  const LOC_MAX = 10;
  if ((rfp.location ?? "").trim().length > 0 && rfp.location !== "California") {
    maxAchievablePoints += LOC_MAX;
    const proxScore = locationProximityScore(rfp.location, profile.workCities ?? [], profile.workCounties ?? []);
    const tokenLocScore = synonymAwareJaccard(rfpLocationTokens, profileLocationTokens);
    const locScore = Math.max(proxScore, tokenLocScore);

    if (locScore > 0) {
      const pts = LOC_MAX * locScore;
      earnedPoints += pts;
      positiveReasons.push("Location aligns with your service area.");
      const profileLocations = [...(profile.workCities ?? []), ...(profile.workCounties ?? [])];
      breakdown.push({ category: "Location", points: Math.round(pts), maxPoints: LOC_MAX, status: locScore >= 0.7 ? "strong" : "partial", detail: "Work location is within your service area.", rfpTokens: [rfp.location], profileTokens: profileLocations });
    } else if (profileLocationTokens.size > 0) {
      const profileLocations = [...(profile.workCities ?? []), ...(profile.workCounties ?? [])];
      negativeReasons.push("Location may be outside your service area.");
      breakdown.push({ category: "Location", points: 0, maxPoints: LOC_MAX, status: "weak", detail: `"${rfp.location}" is not in your listed service areas.`, rfpTokens: [rfp.location], profileTokens: profileLocations });
    } else {
      breakdown.push({ category: "Location", points: 0, maxPoints: LOC_MAX, status: "neutral", detail: "No service areas listed in your profile.", rfpTokens: [rfp.location], profileTokens: [] });
    }
  } else {
    // Generic "California" or empty — neutral, give full credit
    earnedPoints += LOC_MAX;
    maxAchievablePoints += LOC_MAX;
    breakdown.push({ category: "Location", points: LOC_MAX, maxPoints: LOC_MAX, status: "strong", detail: "No specific location restriction." });
  }

  // --- Certifications (max 10 pts) ---
  const CERT_MAX = 10;
  if ((rfp.certifications ?? []).length > 0) {
    maxAchievablePoints += CERT_MAX;
    const certMatch = canonicalSetMatch(rfp.certifications ?? [], profile.certifications ?? [], CERTIFICATION_CANONICAL);
    if (certMatch.matched.length > 0) {
      const pts = CERT_MAX * certMatch.ratio;
      earnedPoints += pts;
      positiveReasons.push(`Certification match: ${certMatch.matched.slice(0, 2).join(", ")}`);
      breakdown.push({ category: "Certifications", points: Math.round(pts), maxPoints: CERT_MAX, status: certMatch.ratio >= 0.75 ? "strong" : "partial", detail: `${certMatch.matched.length}/${rfp.certifications.length} certifications match.`, matchedTokens: certMatch.matched, rfpTokens: rfp.certifications, profileTokens: profile.certifications ?? [] });
    } else {
      negativeReasons.push("RFP lists certifications you may not have.");
      breakdown.push({ category: "Certifications", points: 0, maxPoints: CERT_MAX, status: "missing", detail: "None of the listed certifications found in your profile.", rfpTokens: rfp.certifications, profileTokens: profile.certifications ?? [] });
    }
  } else {
    breakdown.push({ category: "Certifications", points: 0, maxPoints: 0, status: "neutral", detail: "RFP does not list required certifications.", rfpTokens: [], profileTokens: profile.certifications ?? [] });
  }

  // --- Agency Experience (max 5 pts) ---
  // Compare each profile agency individually against the RFP agency (best-match wins).
  // Uses alias expansion so abbreviations match full names (e.g. "Caltrans" ↔ "Department of Transportation").
  const AGENCY_MAX = 5;
  maxAchievablePoints += AGENCY_MAX;
  const rfpAgencyLower = (rfp.agency ?? "").toLowerCase();
  const rfpAgencyToks = toTokenSet([rfp.agency ?? ""]);
  // Expand both RFP and profile agencies with known aliases
  const rfpAgencyAliases = expandAgencyAliases(rfpAgencyLower);
  let bestAgencyScore = 0;
  let matchedAgency = "";
  for (const agency of (profile.agencyExperience ?? [])) {
    const agencyLower = agency.toLowerCase();
    const profileAliases = expandAgencyAliases(agencyLower);
    // Check all alias combinations for substring containment
    const allRfpForms = [rfpAgencyLower, ...rfpAgencyAliases];
    const allProfileForms = [agencyLower, ...profileAliases];
    let matched = false;
    for (const r of allRfpForms) {
      for (const p of allProfileForms) {
        if (p.includes(r) || r.includes(p)) {
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (matched) {
      bestAgencyScore = 1.0;
      matchedAgency = agency;
      break;
    }
    // Token overlap — per-agency Jaccard (not diluted by other agencies)
    const agencyToks = toTokenSet([agency]);
    const sim = synonymAwareJaccard(rfpAgencyToks, agencyToks);
    if (sim > bestAgencyScore) {
      bestAgencyScore = sim;
      matchedAgency = agency;
    }
  }
  if (bestAgencyScore > 0) {
    const pts = scoreFromSimilarity(bestAgencyScore, AGENCY_MAX);
    earnedPoints += pts;
    positiveReasons.push("You have experience with this agency.");
    breakdown.push({ category: "Agency Experience", points: Math.round(pts), maxPoints: AGENCY_MAX, status: bestAgencyScore >= 0.5 ? "strong" : "partial", detail: `Prior experience with ${matchedAgency}.`, rfpTokens: [rfp.agency], profileTokens: profile.agencyExperience ?? [] });
  } else {
    breakdown.push({ category: "Agency Experience", points: 0, maxPoints: AGENCY_MAX, status: "neutral", detail: "No prior experience with this agency.", rfpTokens: [rfp.agency], profileTokens: profile.agencyExperience ?? [] });
  }

  // --- Contract Value / Scale fit (bonus, not in base score) ---
  const rfpValue = parseContractValue(rfp.estimatedValue);
  const profileValue = parseContractValue(profile.totalPastContractValue ?? "");
  if (rfpValue && profileValue) {
    if (rfpValue > profileValue * 10) {
      negativeReasons.push("RFP value significantly exceeds your past contract experience.");
      breakdown.push({ category: "Contract Scale", points: 0, maxPoints: 0, status: "weak", detail: `RFP est. value is much larger than your past contract history.` });
    } else if (rfpValue <= profileValue * 2) {
      positiveReasons.push("Contract size aligns with your experience level.");
      breakdown.push({ category: "Contract Scale", points: 0, maxPoints: 0, status: "strong", detail: "Contract value is within your demonstrated range." });
    }
  }

  // --- Clearance bonus (not in base score) ---
  if (effectiveClearance) {
    const profileLevel = getProfileClearanceLevel(profile.clearances ?? []);
    if (profileLevel >= effectiveClearance.level) {
      positiveReasons.push(`You hold the required ${effectiveClearance.label} clearance.`);
      breakdown.push({ category: "Security Clearance", points: 0, maxPoints: 0, status: "strong", detail: `${effectiveClearance.label} clearance requirement met.` });
    }
  }

  // --- Set-aside bonus ---
  if (rfpSetAsides.length > 0) {
    const profileCanonical = [
      ...(profile.sizeStatus ?? []).map((s) => canonicalize(s, SET_ASIDE_CANONICAL)),
      ...(profile.certifications ?? []).map((c) => canonicalize(c, SET_ASIDE_CANONICAL)),
    ];
    const met = rfpSetAsides.filter((sa) => {
      const saCanonical = canonicalize(sa, SET_ASIDE_CANONICAL);
      return profileCanonical.includes(saCanonical);
    });
    if (met.length > 0) {
      positiveReasons.push(`You qualify for the ${met.join(", ")} set-aside.`);
      breakdown.push({ category: "Set-Aside Status", points: 0, maxPoints: 0, status: "strong", detail: `Eligible for: ${met.join(", ")}.` });
    }
  }

  // --- Deadline status (informational) ---
  if (due) {
    positiveReasons.unshift("Deadline is still open.");
  } else if (!rfp.deadline || rfp.deadline.toUpperCase() !== "TBD") {
    negativeReasons.push("Could not parse deadline.");
  }

  // =========================================================================
  // STAGE 4: Normalize score and assign tier
  // =========================================================================
  // Score = earned / maxAchievable * 100
  // This ensures RFPs missing NAICS/certs/caps don't get penalized.

  const normalizedScore = maxAchievablePoints > 0
    ? clamp(Math.round((earnedPoints / maxAchievablePoints) * 100), 0, 100)
    : 50; // No data at all → neutral 50

  const tier: RFPMatch["tier"] =
    normalizedScore >= 75 ? "excellent" :
    normalizedScore >= 55 ? "strong" :
    normalizedScore >= 35 ? "moderate" :
    "low";

  const reasons = [
    ...positiveReasons.slice(0, 4).map((r) => `✓ ${r}`),
    ...negativeReasons.slice(0, 3).map((r) => `✗ ${r}`),
  ];

  return { score: normalizedScore, tier, disqualified: false, disqualifiers: [], reasons, positiveReasons, negativeReasons, breakdown };
}

// ---------------------------------------------------------------------------
// Summary generation (rule-based fallback)
// ---------------------------------------------------------------------------

export function generateMatchSummary(_rfp: RFP, match: RFPMatch): string {
  const { positiveReasons, negativeReasons, score, disqualified, disqualifiers, tier, breakdown } = match;

  const fmt = (r: string) => {
    const s = r.replace(/\.$/, "");
    return s.charAt(0).toLowerCase() + s.slice(1);
  };

  const strengths = positiveReasons;
  const gaps = negativeReasons;

  // Build specific insights from breakdown scores
  const scored = breakdown.filter((b) => b.maxPoints > 0);
  const topScored = scored
    .filter((b) => b.points > 0)
    .sort((a, b) => (b.points / b.maxPoints) - (a.points / a.maxPoints));
  const topNames = topScored.map((b) => b.category.toLowerCase());

  // Identify the biggest contributor to the score
  const descEntry = scored.find((b) => b.category === "Description Match");
  const descPts = descEntry?.points ?? 0;
  const descIsTop = descPts >= 15; // description drove a big chunk of the score

  if (disqualified && disqualifiers.length > 0) {
    const dq = disqualifiers[0].replace(/\.$/, "");
    return `Not eligible: ${dq.charAt(0).toLowerCase() + dq.slice(1)}.`;
  }

  // Build a reason string from the top 2 specific strengths
  const specificReasons = strengths.slice(0, 2).map(fmt).join(", and ");

  if (tier === "excellent") {
    if (descIsTop && specificReasons) {
      return `Excellent fit — the RFP description closely matches your profile. ${specificReasons.charAt(0).toUpperCase() + specificReasons.slice(1)}.`;
    }
    if (specificReasons) {
      return `Excellent fit: ${specificReasons}. Strong alignment across ${topNames.slice(0, 3).join(", ")}.`;
    }
    return `Strong alignment across ${topNames.slice(0, 3).join(", ")}.`;
  }

  if (tier === "strong") {
    if (descIsTop && specificReasons) {
      return `Good fit — RFP scope aligns with your experience. ${specificReasons.charAt(0).toUpperCase() + specificReasons.slice(1)}.`;
    }
    if (specificReasons) {
      return `Good fit: ${specificReasons}.`;
    }
    return `Good alignment in ${topNames.slice(0, 3).join(", ")}.`;
  }

  if (tier === "moderate") {
    if (specificReasons) {
      return `Partial fit: ${specificReasons}, but limited overlap in other areas.`;
    }
    return `Some overlap in ${topNames.slice(0, 2).join(" and ") || "a few areas"}, but limited overall alignment.`;
  }

  // Low tier
  if (score > 0) {
    if (specificReasons) {
      return `Low match: ${specificReasons}, but most categories don't align.`;
    }
    return "Minimal overlap with your profile across most categories.";
  }

  return "No significant overlap with your profile.";
}
