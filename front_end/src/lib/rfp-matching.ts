// Shared RFP matching logic for dashboard and RFP detail page
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

export interface RFPMatch {
  score: number;
  reasons: string[];
  positiveReasons: string[];
  negativeReasons: string[];
}

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

export function computeMatch(rfp: RFP, profile: CompanyProfile | null): RFPMatch {
  const positiveReasons: string[] = [];
  const negativeReasons: string[] = [];
  let score = 40;

  if (!profile) {
    return {
      score: 50,
      reasons: ["Complete your profile for personalized match scores"],
      positiveReasons: [],
      negativeReasons: [],
    };
  }

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

  const due = parseDeadline(rfp.deadline);
  if (due) {
    const now = new Date();
    if (now > due) {
      score = 5;
      negativeReasons.push("Deadline has passed.");
      const reasons = [
        ...positiveReasons.map((r) => `✓ ${r}`),
        ...negativeReasons.map((r) => `✗ ${r}`),
      ];
      return { score, reasons, positiveReasons, negativeReasons };
    }
    positiveReasons.push("Deadline is still open.");
    score += 6;
  } else if (rfp.deadline?.toUpperCase() !== "TBD") {
    negativeReasons.push("Could not parse deadline.");
  }

  const certOverlap = findTokenOverlap(rfp.certifications ?? [], profileCertTokens);
  if ((rfp.certifications ?? []).length > 0) {
    if (certOverlap.length === 0) {
      score -= 18;
      negativeReasons.push("RFP lists certifications you may not have.");
    } else {
      score += 10;
      positiveReasons.push(
        `Certification overlap: ${certOverlap.slice(0, 2).join(", ")}`
      );
    }
  }

  const locationSimilarity = jaccardSimilarity(
    rfpLocationTokens,
    profileLocationTokens
  );
  if ((rfp.location ?? "").trim().length > 0) {
    if (locationSimilarity === 0 && profileLocationTokens.size > 0) {
      score -= 12;
      negativeReasons.push("Location may be outside your service area.");
    } else if (locationSimilarity > 0) {
      score += 8;
      positiveReasons.push("Location aligns with your service area.");
    }
  }

  const industrySimilarity = jaccardSimilarity(
    rfpIndustryTokens,
    profileIndustryTokens
  );
  if (industrySimilarity > 0) {
    score += scoreFromSimilarity(industrySimilarity, 18);
    positiveReasons.push("Industry aligns with your profile.");
  } else if ((rfp.industry ?? "").trim()) {
    score -= 6;
    negativeReasons.push(
      `Industry (${rfp.industry}) not reflected in your profile.`
    );
  }

  const naicsOverlap = countNaicsOverlap(rfp.naicsCodes ?? [], profileNaics);
  if ((rfp.naicsCodes ?? []).length > 0) {
    if (naicsOverlap.length > 0) {
      const ratio = naicsOverlap.length / Math.max(1, rfp.naicsCodes.length);
      score += 16 * ratio;
      positiveReasons.push(
        `NAICS overlap: ${naicsOverlap.slice(0, 3).join(", ")}`
      );
    } else {
      score -= 6;
      negativeReasons.push("No NAICS overlap.");
    }
  }

  const capSimilarity = jaccardSimilarity(rfpCapTokens, profileCapsTokens);
  const capOverlap = findTokenOverlap(rfp.capabilities ?? [], profileCapsTokens);
  if ((rfp.capabilities ?? []).length > 0) {
    if (capSimilarity > 0 || capOverlap.length > 0) {
      score += scoreFromSimilarity(
        clamp(capSimilarity + capOverlap.length * 0.05, 0, 1),
        26
      );
      positiveReasons.push(
        capOverlap.length > 0
          ? `Capabilities align: ${capOverlap.slice(0, 3).join(", ")}`
          : "Capabilities align with your profile."
      );
    } else {
      score -= 8;
      negativeReasons.push("Limited capability overlap.");
    }
  }

  const profileTextTokens = new Set<string>([
    ...profileIndustryTokens,
    ...profileCapsTokens,
    ...profileCertTokens,
    ...profileAgencyTokens,
  ]);
  const descSimilarity = jaccardSimilarity(rfpDescTokens, profileTextTokens);
  if (descSimilarity > 0.05) {
    score += scoreFromSimilarity(descSimilarity, 12);
    positiveReasons.push(
      "Description language matches your profile keywords."
    );
  }

  const agencySimilarity = jaccardSimilarity(rfpAgencyTokens, profileAgencyTokens);
  if (agencySimilarity > 0) {
    score += scoreFromSimilarity(agencySimilarity, 8);
    positiveReasons.push("You have experience with this agency.");
  }

  const contractSimilarity = jaccardSimilarity(
    rfpContractTokens,
    profileContractTokens
  );
  if (contractSimilarity > 0) {
    score += scoreFromSimilarity(contractSimilarity, 5);
    positiveReasons.push("Contract type matches your preferences.");
  }

  score = clamp(score, 5, 98);
  score = Math.round(score);

  const reasons = [
    ...positiveReasons.slice(0, 3).map((r) => `✓ ${r}`),
    ...negativeReasons.slice(0, 3).map((r) => `✗ ${r}`),
  ];

  return { score, reasons, positiveReasons, negativeReasons };
}

export function generateMatchSummary(
  _rfp: RFP,
  match: RFPMatch
): string {
  const { positiveReasons, negativeReasons, score } = match;
  if (score >= 75 && positiveReasons.length > 0) {
    const topReasons = positiveReasons.slice(0, 3);
    const first =
      topReasons[0].charAt(0).toLowerCase() + topReasons[0].slice(1);
    const rest = topReasons
      .slice(1)
      .map((r) => r.toLowerCase())
      .join(". ");
    return `This RFP is a strong fit for you. ${first}. ${rest}. Worth a close look.`;
  }
  if (score >= 55 && positiveReasons.length > 0) {
    const top = positiveReasons[0].toLowerCase();
    const extra =
      positiveReasons.length > 1
        ? ` Also: ${positiveReasons.slice(1, 2).join(", ").toLowerCase()}.`
        : ".";
    return `This opportunity has potential: ${top}${extra}`;
  }
  if (positiveReasons.length > 0) {
    const align = positiveReasons[0].toLowerCase();
    const hint =
      negativeReasons.length > 0
        ? " Consider updating your profile to improve future matches."
        : "";
    return `Some alignment: ${align}.${hint}`;
  }
  return "Complete your profile for personalized match insights.";
}
