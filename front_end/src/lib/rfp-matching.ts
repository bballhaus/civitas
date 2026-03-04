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
}

export interface ScoreBreakdown {
  category: string;
  points: number;
  maxPoints: number;
  status: "strong" | "partial" | "weak" | "missing" | "neutral";
  detail: string;
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

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length > 2);
}

function toTokenSet(values: string[]): Set<string> {
  const tokens = values.flatMap((value) => tokenize(value));
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function countNaicsOverlap(rfpCodes: string[], profileCodes: string[]): string[] {
  if (rfpCodes.length === 0 || profileCodes.length === 0) return [];
  const normalizedProfile = profileCodes.map((code) => code.trim());
  return rfpCodes.filter((code) =>
    normalizedProfile.some(
      (profileCode) =>
        profileCode === code ||
        profileCode.startsWith(code) ||
        code.startsWith(profileCode)
    )
  );
}

function findTokenOverlap(values: string[], profileTokens: Set<string>): string[] {
  return values.filter((value) => {
    const tokens = tokenize(value);
    return tokens.some((token) => profileTokens.has(token));
  });
}

function scoreFromSimilarity(sim: number, maxPoints: number) {
  const s = clamp(sim, 0, 1);
  return maxPoints * (0.15 + 0.85 * s);
}

// ---------------------------------------------------------------------------
// Domain synonym map — expands tokens so related concepts match
// ---------------------------------------------------------------------------

const SYNONYM_MAP: Record<string, string[]> = {
  // IT / Software
  cloud: ["aws", "azure", "gcp", "saas", "iaas", "paas", "serverless", "hosting"],
  aws: ["cloud", "amazon"],
  azure: ["cloud", "microsoft"],
  gcp: ["cloud", "google"],
  software: ["application", "platform", "development", "programming", "coding"],
  database: ["sql", "nosql", "mongodb", "postgresql", "oracle", "data"],
  devops: ["cicd", "pipeline", "deployment", "containerization", "kubernetes", "docker"],
  kubernetes: ["container", "docker", "orchestration", "devops"],

  // Cybersecurity
  cybersecurity: ["siem", "soc", "penetration", "vulnerability", "firewall", "encryption", "infosec"],
  siem: ["cybersecurity", "monitoring", "logging", "splunk"],
  soc: ["cybersecurity", "monitoring", "incident"],
  penetration: ["pentest", "security", "vulnerability", "assessment"],

  // Construction
  construction: ["demolition", "renovation", "grading", "pavement", "building", "excavation"],
  demolition: ["construction", "removal", "clearing"],
  renovation: ["construction", "remodel", "rehabilitation", "restoration"],
  hvac: ["heating", "ventilation", "cooling", "mechanical", "facilities"],
  plumbing: ["piping", "water", "sewer", "facilities"],
  electrical: ["wiring", "power", "lighting", "facilities"],

  // Engineering
  engineering: ["design", "structural", "civil", "mechanical", "architect"],
  architect: ["design", "engineering", "planning"],

  // Professional services
  consulting: ["advisory", "strategy", "assessment", "analysis"],
  management: ["project", "program", "coordination", "oversight"],

  // Data / AI
  analytics: ["data", "reporting", "dashboard", "visualization", "tableau", "powerbi"],
  machine: ["learning", "model", "prediction", "classification"],
  artificial: ["intelligence", "neural", "deep"],

  // Facilities
  maintenance: ["repair", "upkeep", "preventive", "custodial", "janitorial"],
  janitorial: ["cleaning", "custodial", "sanitation", "maintenance"],
  landscaping: ["grounds", "irrigation", "vegetation", "outdoor"],

  // Fleet
  vehicle: ["fleet", "transportation", "automotive"],
  fleet: ["vehicle", "bus", "truck", "transit"],
  charging: ["electric", "station"],
};

function expandWithSynonyms(tokens: Set<string>): Set<string> {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const synonyms = SYNONYM_MAP[token];
    if (synonyms) {
      for (const syn of synonyms) {
        expanded.add(syn);
      }
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
  if (!v || v.toUpperCase() === "TBD") return null;
  const cleaned = v.replace(/[$,\s]/g, "").toLowerCase();
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(k|m|b)?/);
  if (!match) return null;
  let num = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === "k") num *= 1000;
  else if (suffix === "m") num *= 1000000;
  else if (suffix === "b") num *= 1000000000;
  return num;
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

  const rfpFullText = `${rfp.title} ${rfp.description} ${(rfp.capabilities || []).join(" ")} ${(rfp.certifications || []).join(" ")}`;

  // 1a. Deadline check
  const due = parseDeadline(rfp.deadline);
  if (due) {
    const now = new Date();
    if (now > due) {
      disqualifiers.push("Deadline has passed — this RFP is no longer accepting bids.");
    }
  }

  // 1b. Required clearances
  const requiredClearance = detectRequiredClearance(rfpFullText);
  if (requiredClearance) {
    const profileLevel = getProfileClearanceLevel(profile.clearances ?? []);
    if (profileLevel < requiredClearance.level) {
      disqualifiers.push(
        `Requires ${requiredClearance.label} clearance which is not in your profile.`
      );
    }
  }

  // 1c. Set-aside requirements
  const rfpSetAsides = detectSetAsides(rfpFullText);
  if (rfpSetAsides.length > 0) {
    const profileStatuses = (profile.sizeStatus ?? []).map((s) => s.toLowerCase());
    const profileCerts = (profile.certifications ?? []).map((c) => c.toLowerCase());
    const profileAll = [...profileStatuses, ...profileCerts].join(" ");
    const unmet = rfpSetAsides.filter((sa) => {
      const saLower = sa.toLowerCase();
      return !profileAll.includes(saLower) &&
        !profileStatuses.some((ps) => ps.includes(saLower) || saLower.includes(ps));
    });
    if (unmet.length > 0) {
      disqualifiers.push(
        `Set-aside requirement: ${unmet.join(", ")}. Your profile does not indicate this status.`
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
  const rfpDescTokens = toTokenSet([rfp.description ?? "", rfp.title ?? ""]);

  // =========================================================================
  // STAGE 3: Weighted Scoring (100-point scale)
  // =========================================================================

  let score = 0;

  // --- Capabilities (max 25 pts) ---
  const capSimilarity = synonymAwareJaccard(rfpCapTokens, profileCapsTokens);
  const capOverlap = synonymAwareOverlap(rfp.capabilities ?? [], profileCapsTokens);
  if ((rfp.capabilities ?? []).length > 0) {
    if (capSimilarity > 0 || capOverlap.length > 0) {
      const pts = scoreFromSimilarity(
        clamp(capSimilarity + capOverlap.length * 0.05, 0, 1),
        25
      );
      score += pts;
      const detail = capOverlap.length > 0
        ? `Capabilities align: ${capOverlap.slice(0, 3).join(", ")}`
        : "Capabilities align with your profile.";
      positiveReasons.push(detail);
      breakdown.push({ category: "Capabilities", points: Math.round(pts), maxPoints: 25, status: pts >= 18 ? "strong" : "partial", detail });
    } else {
      negativeReasons.push("Limited capability overlap with your profile.");
      breakdown.push({ category: "Capabilities", points: 0, maxPoints: 25, status: "missing", detail: "No capability overlap detected." });
    }
  } else {
    breakdown.push({ category: "Capabilities", points: 0, maxPoints: 25, status: "neutral", detail: "RFP does not specify required capabilities." });
  }

  // --- Industry (max 20 pts) ---
  const industrySimilarity = synonymAwareJaccard(rfpIndustryTokens, profileIndustryTokens);
  if (industrySimilarity > 0) {
    const pts = scoreFromSimilarity(industrySimilarity, 20);
    score += pts;
    positiveReasons.push("Industry aligns with your profile.");
    breakdown.push({ category: "Industry", points: Math.round(pts), maxPoints: 20, status: pts >= 14 ? "strong" : "partial", detail: "Industry match found." });
  } else if ((rfp.industry ?? "").trim()) {
    negativeReasons.push(`Industry (${rfp.industry}) not reflected in your profile.`);
    breakdown.push({ category: "Industry", points: 0, maxPoints: 20, status: "weak", detail: `Industry "${rfp.industry}" not in your profile.` });
  }

  // --- NAICS Codes (max 15 pts) ---
  const naicsOverlap = countNaicsOverlap(rfp.naicsCodes ?? [], profileNaics);
  if ((rfp.naicsCodes ?? []).length > 0) {
    if (naicsOverlap.length > 0) {
      const ratio = naicsOverlap.length / Math.max(1, rfp.naicsCodes.length);
      const pts = 15 * ratio;
      score += pts;
      positiveReasons.push(`NAICS overlap: ${naicsOverlap.slice(0, 3).join(", ")}`);
      breakdown.push({ category: "NAICS Codes", points: Math.round(pts), maxPoints: 15, status: ratio >= 0.75 ? "strong" : "partial", detail: `${naicsOverlap.length}/${rfp.naicsCodes.length} codes match.` });
    } else {
      negativeReasons.push("No NAICS code overlap.");
      breakdown.push({ category: "NAICS Codes", points: 0, maxPoints: 15, status: "missing", detail: "None of the RFP's NAICS codes match your profile." });
    }
  } else {
    breakdown.push({ category: "NAICS Codes", points: 0, maxPoints: 15, status: "neutral", detail: "RFP does not list NAICS codes." });
  }

  // --- Certifications (max 12 pts) ---
  const certOverlap = findTokenOverlap(rfp.certifications ?? [], profileCertTokens);
  if ((rfp.certifications ?? []).length > 0) {
    if (certOverlap.length > 0) {
      const ratio = certOverlap.length / Math.max(1, (rfp.certifications ?? []).length);
      const pts = 12 * ratio;
      score += pts;
      positiveReasons.push(`Certification match: ${certOverlap.slice(0, 2).join(", ")}`);
      breakdown.push({ category: "Certifications", points: Math.round(pts), maxPoints: 12, status: ratio >= 0.75 ? "strong" : "partial", detail: `${certOverlap.length}/${rfp.certifications.length} certifications match.` });
    } else {
      negativeReasons.push("RFP lists certifications you may not have.");
      breakdown.push({ category: "Certifications", points: 0, maxPoints: 12, status: "missing", detail: "None of the listed certifications found in your profile." });
    }
  } else {
    breakdown.push({ category: "Certifications", points: 0, maxPoints: 12, status: "neutral", detail: "RFP does not list required certifications." });
  }

  // --- Location (max 10 pts) ---
  const locationSimilarity = synonymAwareJaccard(rfpLocationTokens, profileLocationTokens);
  if ((rfp.location ?? "").trim().length > 0) {
    if (locationSimilarity > 0) {
      const pts = scoreFromSimilarity(locationSimilarity, 10);
      score += pts;
      positiveReasons.push("Location aligns with your service area.");
      breakdown.push({ category: "Location", points: Math.round(pts), maxPoints: 10, status: "strong", detail: "Work location is within your service area." });
    } else if (profileLocationTokens.size > 0) {
      negativeReasons.push("Location may be outside your service area.");
      breakdown.push({ category: "Location", points: 0, maxPoints: 10, status: "weak", detail: `"${rfp.location}" is not in your listed service areas.` });
    } else {
      breakdown.push({ category: "Location", points: 0, maxPoints: 10, status: "neutral", detail: "No service areas listed in your profile." });
    }
  }

  // --- Agency Experience (max 8 pts) ---
  const agencySimilarity = synonymAwareJaccard(rfpAgencyTokens, profileAgencyTokens);
  if (agencySimilarity > 0) {
    const pts = scoreFromSimilarity(agencySimilarity, 8);
    score += pts;
    positiveReasons.push("You have experience with this agency.");
    breakdown.push({ category: "Agency Experience", points: Math.round(pts), maxPoints: 8, status: "strong", detail: `Prior experience with ${rfp.agency}.` });
  } else if (profileAgencyTokens.size > 0) {
    breakdown.push({ category: "Agency Experience", points: 0, maxPoints: 8, status: "neutral", detail: "No prior experience with this agency." });
  }

  // --- Contract Type (max 5 pts) ---
  const contractSimilarity = jaccardSimilarity(rfpContractTokens, profileContractTokens);
  if (contractSimilarity > 0) {
    const pts = scoreFromSimilarity(contractSimilarity, 5);
    score += pts;
    positiveReasons.push("Contract type matches your preferences.");
    breakdown.push({ category: "Contract Type", points: Math.round(pts), maxPoints: 5, status: "strong", detail: "Contract type aligns with your preferences." });
  } else {
    breakdown.push({ category: "Contract Type", points: 0, maxPoints: 5, status: "neutral", detail: "Contract type not in your listed preferences." });
  }

  // --- Description / Title text match (max 5 pts) ---
  const profileTextTokens = new Set<string>([
    ...expandWithSynonyms(profileIndustryTokens),
    ...expandWithSynonyms(profileCapsTokens),
    ...expandWithSynonyms(profileCertTokens),
    ...profileAgencyTokens,
  ]);
  const descSimilarity = jaccardSimilarity(rfpDescTokens, profileTextTokens);
  if (descSimilarity > 0.05) {
    const pts = scoreFromSimilarity(descSimilarity, 5);
    score += pts;
    positiveReasons.push("Description language matches your profile keywords.");
    breakdown.push({ category: "Description Match", points: Math.round(pts), maxPoints: 5, status: "partial", detail: "Keywords in the RFP description overlap with your profile." });
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
  if (requiredClearance) {
    const profileLevel = getProfileClearanceLevel(profile.clearances ?? []);
    if (profileLevel >= requiredClearance.level) {
      positiveReasons.push(`You hold the required ${requiredClearance.label} clearance.`);
      breakdown.push({ category: "Security Clearance", points: 0, maxPoints: 0, status: "strong", detail: `${requiredClearance.label} clearance requirement met.` });
    }
  }

  // --- Set-aside bonus ---
  if (rfpSetAsides.length > 0) {
    const profileStatuses = (profile.sizeStatus ?? []).map((s) => s.toLowerCase());
    const profileCerts = (profile.certifications ?? []).map((c) => c.toLowerCase());
    const profileAll = [...profileStatuses, ...profileCerts].join(" ");
    const met = rfpSetAsides.filter((sa) => {
      const saLower = sa.toLowerCase();
      return profileAll.includes(saLower) ||
        profileStatuses.some((ps) => ps.includes(saLower) || saLower.includes(ps));
    });
    if (met.length > 0) {
      positiveReasons.push(`You qualify for the ${met.join(", ")} set-aside.`);
      breakdown.push({ category: "Set-Aside Status", points: 0, maxPoints: 0, status: "strong", detail: `Eligible for: ${met.join(", ")}.` });
    }
  }

  // --- Deadline status (informational, not scored but displayed) ---
  if (due) {
    positiveReasons.unshift("Deadline is still open.");
    breakdown.unshift({ category: "Deadline", points: 0, maxPoints: 0, status: "strong", detail: `Due ${rfp.deadline}. Deadline is still open.` });
  } else if (rfp.deadline?.toUpperCase() === "TBD") {
    breakdown.unshift({ category: "Deadline", points: 0, maxPoints: 0, status: "neutral", detail: "Deadline is TBD." });
  } else {
    negativeReasons.push("Could not parse deadline.");
    breakdown.unshift({ category: "Deadline", points: 0, maxPoints: 0, status: "weak", detail: "Could not determine deadline status." });
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
  const { positiveReasons, negativeReasons, score, disqualified, disqualifiers, tier } = match;

  if (disqualified && disqualifiers.length > 0) {
    return `Not eligible: ${disqualifiers[0].toLowerCase()}`;
  }

  if (tier === "excellent" && positiveReasons.length > 0) {
    const topReasons = positiveReasons.filter((r) => r !== "Deadline is still open.").slice(0, 3);
    if (topReasons.length === 0) return "Strong overall alignment with your profile.";
    const first = topReasons[0].charAt(0).toLowerCase() + topReasons[0].slice(1);
    const rest = topReasons.slice(1).map((r) => r.charAt(0).toLowerCase() + r.slice(1)).join(". ");
    return `Excellent fit: ${first}.${rest ? ` ${rest}.` : ""} Worth a close look.`;
  }

  if (tier === "strong" && positiveReasons.length > 0) {
    const top = positiveReasons.filter((r) => r !== "Deadline is still open.").slice(0, 2);
    if (top.length === 0) return "Good overall alignment with your profile.";
    const first = top[0].charAt(0).toLowerCase() + top[0].slice(1);
    const extra = top.length > 1 ? ` Also: ${top[1].charAt(0).toLowerCase() + top[1].slice(1)}.` : "";
    return `Strong potential: ${first}.${extra}`;
  }

  if (tier === "moderate" && positiveReasons.length > 0) {
    const align = positiveReasons.filter((r) => r !== "Deadline is still open.")[0];
    if (!align) return "Some alignment found. Review details for fit.";
    const hint = negativeReasons.length > 0
      ? " Consider updating your profile to improve match accuracy."
      : "";
    const alignText = align.replace(/\.$/, "");
    return `Some alignment: ${alignText.charAt(0).toLowerCase() + alignText.slice(1)}.${hint}`;
  }

  if (score > 0 && positiveReasons.length > 0) {
    const reason = positiveReasons[0].replace(/\.$/, "");
    return `Limited alignment: ${reason.charAt(0).toLowerCase() + reason.slice(1)}. Consider updating your profile to improve future matches.`;
  }

  return "Complete your profile for personalized match insights.";
}
