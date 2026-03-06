// Shared RFP matching logic for dashboard and RFP detail page
// Pipeline: Hard Disqualifiers → Synonym Expansion → Weighted Scoring → Explanations

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
  // California-specific
  "small business (sb)": "small_business_ca", "certified sb": "small_business_ca",
  "dvbe": "dvbe", "disabled veteran business enterprise": "dvbe",
  "california business license": "ca_business_license",
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
  const matched = rfpValues.filter((v) => profileCanonical.has(canonicalize(v, canonicalMap)));
  return {
    ratio: matched.length / Math.max(1, rfpValues.length),
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

function getSynonyms(token: string): Set<string> {
  const domain = SYNONYM_MAP[token];
  if (domain && domain.size > 0) return domain;

  // Fallback to general English synonyms (nouns only, skip generic words)
  if (_synonymsLib) {
    const SKIP = new Set(["system", "group", "unit", "part", "point", "line", "set", "body", "field", "plan", "area", "order", "form"]);
    if (SKIP.has(token)) return new Set();
    const result = _synonymsLib(token);
    if (result?.n) {
      const nouns = result.n.filter((s: string) => s !== token && s.length > 2 && !SKIP.has(s));
      if (nouns.length > 0) return new Set(nouns.slice(0, 6));
    }
  }

  return new Set();
}

// Generic terms that should NOT be expanded via synonyms (too broad, cause false positives)
const STOP_EXPANSION = new Set([
  "development", "management", "services", "support", "system", "systems",
  "solution", "solutions", "general", "operations", "process", "design",
  "analysis", "planning", "implementation", "service", "project",
]);

function expandWithSynonyms(tokens: Set<string>): Set<string> {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    if (STOP_EXPANSION.has(token)) continue;
    const synonyms = getSynonyms(token);
    for (const syn of synonyms) {
      expanded.add(syn);
    }
  }
  return expanded;
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

  const profileIndustryTokens = toTokenSet(profile.industry ?? []);
  const profileNaics = profile.naicsCodes ?? [];
  const profileCapsTokens = toTokenSet(profile.capabilities ?? []);
  const profileCertTokens = toTokenSet(profile.certifications ?? []);
  const profileAgencyTokens = toTokenSet(profile.agencyExperience ?? []);
  const profileContractTokens = toTokenSet(profile.contractTypes ?? []);
  const profileLocationTokens = toTokenSet([
    ...(profile.workCities ?? []),
    ...(profile.workCounties ?? []),
  ]);

  const rfpIndustryTokens = toTokenSet([rfp.industry ?? ""]);
  const rfpCapTokens = toTokenSet(rfp.capabilities ?? []);
  const rfpAgencyTokens = toTokenSet([rfp.agency ?? ""]);
  const rfpContractTokens = toTokenSet([rfp.contractType ?? ""]);
  const rfpLocationTokens = toTokenSet([rfp.location ?? ""]);
  const rfpDescTokens = toTokenSet([
    rfp.description ?? "",
    rfp.title ?? "",
    ...(rfp.deliverables ?? []),
    rfp.attachmentRollup?.summary ?? "",
  ]);

  // =========================================================================
  // STAGE 3: Weighted Scoring (100-point scale)
  // =========================================================================

  let score = 0;

  // --- Capabilities (max 15 pts) ---
  // Empty = 50% (relevance unknown, not a positive signal)
  const capSimilarity = synonymAwareJaccard(rfpCapTokens, profileCapsTokens);
  const capOverlap = synonymAwareOverlap(rfp.capabilities ?? [], profileCapsTokens);
  if ((rfp.capabilities ?? []).length > 0) {
    if (capSimilarity > 0 || capOverlap.length > 0) {
      const pts = scoreFromSimilarity(
        clamp(capSimilarity + capOverlap.length * 0.05, 0, 1),
        15
      );
      score += pts;
      const detail = capOverlap.length > 0
        ? `Capabilities align: ${capOverlap.slice(0, 3).join(", ")}`
        : "Capabilities align with your profile.";
      positiveReasons.push(detail);
      breakdown.push({ category: "Capabilities", points: Math.round(pts), maxPoints: 25, status: pts >= 18 ? "strong" : "partial", detail, matchedTokens: capOverlap, rfpTokens: rfp.capabilities ?? [], profileTokens: profile.capabilities ?? [] });
    } else {
      negativeReasons.push("Limited capability overlap with your profile.");
      breakdown.push({ category: "Capabilities", points: 0, maxPoints: 25, status: "missing", detail: "No capability overlap detected.", rfpTokens: rfp.capabilities ?? [], profileTokens: profile.capabilities ?? [] });
    }
  } else {
    breakdown.push({ category: "Capabilities", points: 0, maxPoints: 25, status: "neutral", detail: "RFP does not specify required capabilities.", rfpTokens: [], profileTokens: profile.capabilities ?? [] });
  }

  // --- Industry (max 12 pts) ---
  // Empty = 50% (relevance unknown)
  const industrySimilarity = synonymAwareJaccard(rfpIndustryTokens, profileIndustryTokens);
  if (industrySimilarity > 0) {
    const pts = scoreFromSimilarity(industrySimilarity, 20);
    score += pts;
    positiveReasons.push("Industry aligns with your profile.");
    breakdown.push({ category: "Industry", points: Math.round(pts), maxPoints: 20, status: pts >= 14 ? "strong" : "partial", detail: "Industry match found.", rfpTokens: [rfp.industry], profileTokens: profile.industry ?? [] });
  } else if ((rfp.industry ?? "").trim()) {
    negativeReasons.push(`Industry (${rfp.industry}) not reflected in your profile.`);
    breakdown.push({ category: "Industry", points: 0, maxPoints: 20, status: "weak", detail: `Industry "${rfp.industry}" not in your profile.`, rfpTokens: [rfp.industry], profileTokens: profile.industry ?? [] });
  }

  // --- NAICS Codes (max 10 pts) ---
  // Empty = 50% (relevance unknown)
  const naicsOverlap = countNaicsOverlap(rfp.naicsCodes ?? [], profileNaics);
  if ((rfp.naicsCodes ?? []).length > 0) {
    if (naicsOverlap.length > 0) {
      const ratio = naicsOverlap.length / Math.max(1, rfp.naicsCodes.length);
      const pts = 10 * ratio;
      score += pts;
      positiveReasons.push(`NAICS overlap: ${naicsOverlap.slice(0, 3).join(", ")}`);
      breakdown.push({ category: "NAICS Codes", points: Math.round(pts), maxPoints: 15, status: ratio >= 0.75 ? "strong" : "partial", detail: `${naicsOverlap.length}/${rfp.naicsCodes.length} codes match.`, matchedTokens: naicsOverlap, rfpTokens: rfp.naicsCodes, profileTokens: profileNaics });
    } else {
      negativeReasons.push("No NAICS code overlap.");
      breakdown.push({ category: "NAICS Codes", points: 0, maxPoints: 15, status: "missing", detail: "None of the RFP's NAICS codes match your profile.", rfpTokens: rfp.naicsCodes, profileTokens: profileNaics });
    }
  } else {
    breakdown.push({ category: "NAICS Codes", points: 0, maxPoints: 15, status: "neutral", detail: "RFP does not list NAICS codes.", rfpTokens: [], profileTokens: profileNaics });
  }

  // --- Certifications (max 10 pts) ---
  // ELIGIBILITY category: no cert requirement = full points (everyone eligible)
  if ((rfp.certifications ?? []).length > 0) {
    const certMatch = canonicalSetMatch(rfp.certifications ?? [], profile.certifications ?? [], CERTIFICATION_CANONICAL);
    if (certMatch.matched.length > 0) {
      const pts = 10 * certMatch.ratio;
      score += pts;
      positiveReasons.push(`Certification match: ${certOverlap.slice(0, 2).join(", ")}`);
      breakdown.push({ category: "Certifications", points: Math.round(pts), maxPoints: 12, status: ratio >= 0.75 ? "strong" : "partial", detail: `${certOverlap.length}/${rfp.certifications.length} certifications match.`, matchedTokens: certOverlap, rfpTokens: rfp.certifications, profileTokens: profile.certifications ?? [] });
    } else {
      negativeReasons.push("RFP lists certifications you may not have.");
      breakdown.push({ category: "Certifications", points: 0, maxPoints: 12, status: "missing", detail: "None of the listed certifications found in your profile.", rfpTokens: rfp.certifications, profileTokens: profile.certifications ?? [] });
    }
  } else {
    breakdown.push({ category: "Certifications", points: 0, maxPoints: 12, status: "neutral", detail: "RFP does not list required certifications.", rfpTokens: [], profileTokens: profile.certifications ?? [] });
  }

  // --- Location (max 8 pts) ---
  // Use geographic proximity instead of pure token Jaccard
  if ((rfp.location ?? "").trim().length > 0) {
    const proxScore = locationProximityScore(rfp.location, profile.workCities ?? [], profile.workCounties ?? []);
    // Also try token Jaccard as fallback
    const tokenLocScore = synonymAwareJaccard(rfpLocationTokens, profileLocationTokens);
    const locScore = Math.max(proxScore, tokenLocScore);

    if (locScore > 0) {
      const pts = 8 * locScore;
      score += pts;
      const locDetail = proxScore >= 0.75 ? "Work location is in your metro area." : "Work location aligns with your service area.";
      positiveReasons.push("Location aligns with your service area.");
      const profileLocations = [...(profile.workCities ?? []), ...(profile.workCounties ?? [])];
      breakdown.push({ category: "Location", points: Math.round(pts), maxPoints: 10, status: "strong", detail: "Work location is within your service area.", rfpTokens: [rfp.location], profileTokens: profileLocations });
    } else if (profileLocationTokens.size > 0) {
      const profileLocations = [...(profile.workCities ?? []), ...(profile.workCounties ?? [])];
      negativeReasons.push("Location may be outside your service area.");
      breakdown.push({ category: "Location", points: 0, maxPoints: 10, status: "weak", detail: `"${rfp.location}" is not in your listed service areas.`, rfpTokens: [rfp.location], profileTokens: profileLocations });
    } else {
      breakdown.push({ category: "Location", points: 0, maxPoints: 10, status: "neutral", detail: "No service areas listed in your profile.", rfpTokens: [rfp.location], profileTokens: [] });
    }
  } else {
    score += 8;
    breakdown.push({ category: "Location", points: 8, maxPoints: 8, status: "strong", detail: "No location restriction." });
  }

  // --- Agency Experience (max 10 pts) ---
  // Agency match is a bonus — 0 for no match (not penalized, but not rewarded)
  const agencySimilarity = synonymAwareJaccard(rfpAgencyTokens, profileAgencyTokens);
  if (agencySimilarity > 0) {
    const pts = scoreFromSimilarity(agencySimilarity, 10);
    score += pts;
    positiveReasons.push("You have experience with this agency.");
    breakdown.push({ category: "Agency Experience", points: Math.round(pts), maxPoints: 8, status: "strong", detail: `Prior experience with ${rfp.agency}.`, rfpTokens: [rfp.agency], profileTokens: profile.agencyExperience ?? [] });
  } else if (profileAgencyTokens.size > 0) {
    breakdown.push({ category: "Agency Experience", points: 0, maxPoints: 8, status: "neutral", detail: "No prior experience with this agency.", rfpTokens: [rfp.agency], profileTokens: profile.agencyExperience ?? [] });
  }

  // --- Contract Type (max 5 pts) ---
  const contractSimilarity = jaccardSimilarity(rfpContractTokens, profileContractTokens);
  if (contractSimilarity > 0) {
    const pts = scoreFromSimilarity(contractSimilarity, 5);
    score += pts;
    positiveReasons.push("Contract type matches your preferences.");
    breakdown.push({ category: "Contract Type", points: Math.round(pts), maxPoints: 5, status: "strong", detail: "Contract type aligns with your preferences.", rfpTokens: [rfp.contractType], profileTokens: profile.contractTypes ?? [] });
  } else {
    breakdown.push({ category: "Contract Type", points: 0, maxPoints: 5, status: "neutral", detail: "Contract type not in your listed preferences.", rfpTokens: [rfp.contractType], profileTokens: profile.contractTypes ?? [] });
  }

  // --- Description / Title text match (max 30 pts) ---
  // Highest weight — the best signal for actual content relevance.
  // Uses COVERAGE metric instead of Jaccard: what fraction of profile keywords
  // appear in the RFP description? Jaccard fails here because both token sets
  // are large (200+ tokens) so even 20 overlapping tokens give tiny ratios.
  // Stop words are filtered from both sides so only domain-relevant terms count.
  const profileCompanyTokens = profile.companyName
    ? new Set(tokenize(profile.companyName).filter((t) => !STOP_WORDS.has(t)))
    : new Set<string>();
  const profileTechTokens = (profile.technologyStack ?? []).length > 0
    ? new Set(profile.technologyStack!.flatMap((t) => tokenize(t)).filter((t) => !STOP_WORDS.has(t)))
    : new Set<string>();
  const profileTextTokens = new Set<string>([
    ...expandWithSynonyms(profileIndustryTokens),
    ...expandWithSynonyms(profileCapsTokens),
    ...expandWithSynonyms(profileCertTokens),
    ...profileAgencyTokens,
    ...profileCompanyTokens,
    ...expandWithSynonyms(profileTechTokens),
  ]);
  // Filter stop words from both sides for description matching only
  const profileTextFiltered = new Set([...profileTextTokens].filter((t) => !STOP_WORDS.has(t)));
  const rfpDescFiltered = new Set([...rfpDescTokens].filter((t) => !STOP_WORDS.has(t)));
  // Coverage: what fraction of the PROFILE tokens appear in the RFP description
  const descOverlapTokens = [...profileTextFiltered].filter((t) => rfpDescFiltered.has(t));
  const descCoverage = descOverlapTokens.length / Math.max(1, profileTextFiltered.size);
  // Also compute reverse coverage: what fraction of RFP description's meaningful tokens match profile
  const rfpInProfile = [...rfpDescFiltered].filter((t) => profileTextFiltered.has(t));
  const reverseCoverage = rfpInProfile.length / Math.max(1, rfpDescFiltered.size);
  // Use the geometric mean of both coverages to balance the signal
  const descRelevance = Math.sqrt(descCoverage * reverseCoverage);
  // Also keep Jaccard as a floor (prevents zero-scoring when coverage is asymmetric)
  const descJaccard = jaccardSimilarity(rfpDescFiltered, profileTextFiltered);
  const descScore = Math.max(descRelevance, descJaccard);

  if (descScore > 0.01) {
    const pts = scoreFromSimilarity(Math.min(descScore * 2.5, 1), 30); // scale up: 0.40 coverage → full points
    score += pts;
    positiveReasons.push("Description language matches your profile keywords.");
    const descMatched = [...rfpDescTokens].filter(t => profileTextTokens.has(t));
    breakdown.push({ category: "Description Match", points: Math.round(pts), maxPoints: 5, status: "partial", detail: "Keywords in the RFP description overlap with your profile.", matchedTokens: descMatched.slice(0, 10), rfpTokens: [...rfpDescTokens].slice(0, 15), profileTokens: [...profileTextTokens].slice(0, 15) });
  }

  // --- Contract Value / Scale fit (bonus, not in base 100) ---
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

  // --- Clearance bonus (not in base 100, but boost if matched) ---
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

  // --- Deadline status (informational, kept in reasons but not in breakdown chart) ---
  if (due) {
    positiveReasons.unshift("Deadline is still open.");
  } else if (!rfp.deadline || rfp.deadline.toUpperCase() !== "TBD") {
    negativeReasons.push("Could not parse deadline.");
  }

  // =========================================================================
  // STAGE 4: Final score and tier
  // =========================================================================

  score = clamp(Math.round(score), 0, 100);

  const tier: RFPMatch["tier"] =
    score >= 75 ? "excellent" :
    score >= 55 ? "strong" :
    score >= 35 ? "moderate" :
    "low";

  const reasons = [
    ...positiveReasons.slice(0, 4).map((r) => `✓ ${r}`),
    ...negativeReasons.slice(0, 3).map((r) => `✗ ${r}`),
  ];

  return { score, tier, disqualified: false, disqualifiers: [], reasons, positiveReasons, negativeReasons, breakdown };
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
