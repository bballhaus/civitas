// v2 matching algorithm (Architecture-v2 § 9 + § 10).
//
// Replaces the synonym-Jaccard scorer in rfp-matching.ts. Differences worth
// calling out before reading:
//
//   1. Empty fields are UNKNOWN, not zero. A PlanetBids RFP with
//      `licenses_required: []` does not mean "no license needed" — it means
//      "PDFs are gated, we don't know." Hard gates fire only when the RFP
//      field is non-empty (spec § 9.2).
//
//   2. Semantic matches are confidence-weighted by data quality. BidSync's
//      title-only embeddings cannot speak as loudly as Cal eProcure's
//      attachment-rollup-backed ones (spec § 9.4).
//
//   3. Win probability is separated from score. A high-fit RFP with a likely
//      incumbent reads as "good fit, probably not worth bidding." Incumbent
//      detection is source-routed via the § 10 state machine.
//
//   4. Sub-on-prime track runs in parallel — failing a prime gate routes
//      the RFP to sub rather than disqualifying outright (spec § 9.7).
//
//   5. Every category produces a citation: the RFP phrase + the profile
//      claim that justifies the score (spec § 9.10).

import type { FullProfile } from "@/db/queries/profile";
import type { RfpCacheRow } from "@/db/schema";
import {
  lookupNaicsSimilarity,
  lookupNaicsSimilarityDetailed,
} from "@/lib/naics-similarity";
import { NAICS_MAP } from "@/data/filter-options";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Tier =
  | "excellent"
  | "strong"
  | "moderate"
  | "low"
  | "minimal"
  | "not_eligible";

export type CategoryStatus =
  | "strong"
  | "partial"
  | "weak"
  | "missing"
  | "neutral"
  | "unknown";

export interface CategoryBreakdown {
  category: string;
  status: CategoryStatus;
  // Normalized 0..1 score for the category. `null` means neutral/unknown —
  // category is excluded from the weighted sum (spec § 9.2 "unknown" handling).
  score: number | null;
  weight: number;
  // Free-form explanation suitable for the UI tooltip.
  detail: string;
  // Citation — the verbatim RFP phrase and the profile claim that backed it.
  rfpPhrase?: string;
  profileClaim?: string;
  profileClaimSource?: string;
}

export interface IncumbentStateInfo {
  state: "likely" | "open_field" | "unknown";
  confidence: number | null;
  source:
    | "text_extraction"
    | "award_history"
    | "thin_bid_response"
    | "distinct_winners"
    | "none";
  namedVendor?: string;
  contractEnd?: string;
}

export interface DataQuality {
  sourceId: string;
  hasPdfExtraction: boolean;
  hasMarketIntel: boolean;
  // Plain-English summary used by the dashboard "data quality" badge.
  coverage:
    | "full"
    | "requirements_only"
    | "market_intel_only"
    | "thin";
}

export interface MatchResult {
  score: number; // 0-100
  winProbability: number; // 0-100
  tier: Tier;
  primeEligible: boolean;
  subEligible: boolean;
  incumbent: IncumbentStateInfo;
  dataQuality: DataQuality;
  breakdown: CategoryBreakdown[];
  // Sub-on-prime track. Always computed (spec § 9.7); only meaningful if the
  // user is open to subbing or prime gates failed.
  subTrack: {
    eligible: boolean;
    score: number;
    breakdown: CategoryBreakdown[];
  };
  // Aggregate disqualifier reasons surfaced when primeEligible=false.
  gateFailures: string[];
}

// ---------------------------------------------------------------------------
// Category weights (spec § 9.8). Sum to 1.0. Any category with a null score
// is dropped from both numerator AND denominator so unknown categories
// don't penalize the total.
// ---------------------------------------------------------------------------

// Capability is the NAICS-substitutes scorer (see data/naics-substitutes.json
// + lib/naics-similarity.ts) — measures substitutability across related
// codes via the curated matrix. Specialty is a direct-overlap preference
// boost: fires only when the user's exact NAICS pick (from onboarding,
// including LLM-inferred from free-text — see lib/profile-naics.ts) is in
// the RFP's NAICS list. The two are paired by design: Capability says "you
// CAN do this work," Specialty says "you specifically chose this." Scope
// is the dollar-value/budget-band scorer (unchanged from v1).
const WEIGHTS: Record<string, number> = {
  capability: 0.4,
  specialty: 0.1,
  scope: 0.15,
  complexity: 0.1,
  agency: 0.1,
  location: 0.1,
  duration: 0.05,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function matchV2(profile: FullProfile, rfp: RfpCacheRow): MatchResult {
  const gateFailures = checkHardGates(profile, rfp);
  const primeEligible = gateFailures.length === 0;

  const dataQuality = computeDataQuality(rfp);
  const incumbent = computeIncumbentState(rfp);

  const primeBreakdown: CategoryBreakdown[] = [
    scoreCapability(profile, rfp),
    scoreSpecialty(profile, rfp),
    scoreScope(profile, rfp),
    scoreDuration(profile, rfp),
    scoreComplexity(profile, rfp),
    scoreAgency(profile, rfp),
    scoreLocation(profile, rfp),
  ];

  const softBonus = softCertBonus(profile, rfp);
  const rawScore = aggregateWeighted(primeBreakdown) + softBonus;
  const score = clamp01to100(rawScore);

  const winProbability = clamp01to100(rawScore * incumbentMultiplier(incumbent));

  // Sub track — looser gates, specialty weighted higher (spec § 9.7).
  const sub = scoreAsSub(profile, rfp);

  const tier = primeEligible ? tierFor(score) : sub.eligible ? tierFor(sub.score) : "not_eligible";

  return {
    score: primeEligible ? score : 0,
    winProbability: primeEligible ? winProbability : 0,
    tier,
    primeEligible,
    subEligible: sub.eligible,
    incumbent,
    dataQuality,
    breakdown: primeBreakdown,
    subTrack: sub,
    gateFailures,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — Hard gates (spec § 9.2). Each gate fires ONLY when the RFP
// exposes the relevant field; otherwise we say "unknown" and let the gate
// pass. Failures route to the sub track, not to a flat disqualification.
// ---------------------------------------------------------------------------

function checkHardGates(profile: FullProfile, rfp: RfpCacheRow): string[] {
  const failures: string[] = [];

  // License class
  if (rfp.licensesRequired && rfp.licensesRequired.length > 0) {
    const heldClasses = new Set(profile.licenses.map((l) => l.licenseClass.toUpperCase()));
    const missing = rfp.licensesRequired.filter((req) => {
      const reqClass = normalizeLicenseClass(req);
      return reqClass && !heldClasses.has(reqClass);
    });
    if (missing.length > 0) {
      failures.push(`Missing license class: ${missing.join(", ")}`);
    }
  }

  // Hard certifications. RFP requirements come as raw strings; we look for
  // canonical_id overlap. Profile holds certifications with kind='hard'.
  if (rfp.certificationsRequired && rfp.certificationsRequired.length > 0) {
    const heldHard = new Set(
      profile.certifications.filter((c) => c.kind === "hard").map((c) => c.canonicalId),
    );
    const missingHard = rfp.certificationsRequired
      .map((req) => canonicalizeCert(req))
      .filter((c): c is string => !!c)
      .filter((c) => !heldHard.has(c));
    if (missingHard.length > 0) {
      failures.push(`Missing certification(s): ${missingHard.join(", ")}`);
    }
  }

  // Set-aside lockout (e.g. small-business-only). Profile must qualify for
  // at least one of the lockouts to be eligible as prime.
  if (rfp.setAsideLockout && rfp.setAsideLockout.length > 0) {
    const held = new Set(profile.certifications.map((c) => c.canonicalId));
    const allowed = rfp.setAsideLockout
      .map((s) => canonicalizeCert(s))
      .filter((c): c is string => !!c);
    const qualifies = allowed.some((c) => held.has(c));
    if (!qualifies) {
      failures.push(`Restricted to set-aside: ${rfp.setAsideLockout.join(", ")}`);
    }
  }

  // Hard work area — profile asserts "won't travel outside these" via the
  // is_hard flag; if it's set on any row, the RFP location must intersect
  // at least one of those rows.
  const hardAreas = profile.workAreas.filter((w) => w.isHard);
  if (hardAreas.length > 0 && rfp.location) {
    const loc = rfp.location.toLowerCase();
    const ok = hardAreas.some((a) => loc.includes(a.name.toLowerCase()));
    if (!ok) {
      failures.push(`Outside your hard work area limit (${hardAreas.map((a) => a.name).join(", ")})`);
    }
  }

  // Past gov experience gate. govExperience is a text[] — a profile claiming
  // {none} or an empty/null array fails the gate; any other tier (local,
  // state, federal) lets it through.
  const govTiers = profile.govExperience ?? [];
  const hasRealGovExp = govTiers.some((t) => t && t !== "none");
  if (rfp.requiresPastGovExp === true && !hasRealGovExp) {
    failures.push("Requires past government contract experience");
  }

  // NAICS-capability gate (Moderate eligibility per design notes 2026-05-26).
  // Prime requires vendor to hold ANY code with substitutability >= 0.5
  // against the RFP's primary NAICS. Fires only when BOTH sides have
  // codes — unknown on either side falls through to "pass" so we don't
  // lock out profiles that haven't yet picked NAICS or RFPs from
  // sources without NAICS extraction.
  const primaryNaics = rfp.naicsCodes?.[0];
  const profileNaics = profile.naicsCodes ?? [];
  if (primaryNaics && profileNaics.length > 0) {
    const bestSim = Math.max(
      ...profileNaics.map((vc) => lookupNaicsSimilarity(vc, primaryNaics)),
    );
    if (bestSim < 0.5) {
      const primaryTitle = NAICS_MAP[primaryNaics] ?? primaryNaics;
      failures.push(`Required capability (NAICS ${primaryNaics} — ${primaryTitle}) doesn't substantially match your industries`);
    }
  }

  return failures;
}

// Common normalization for the CSLB class strings the RFP scrapers surface.
function normalizeLicenseClass(s: string): string | null {
  const trimmed = s.trim().toUpperCase();
  if (!trimmed) return null;
  // Match "CLASS A", "A", "C-12", "C 12" etc.
  const m = trimmed.match(/(?:CLASS\s+)?([A-Z](?:[-\s]?\d{1,2})?)/);
  if (!m) return null;
  return m[1].replace(/\s+/g, "-");
}

// Tiny inline canonicalizer for set-aside / hard-cert names. Matches the
// canonical_id strings used in onboarding-data.ts.
function canonicalizeCert(s: string): string | null {
  const norm = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  // A few well-known aliases. Add as the catalog grows.
  const aliases: Record<string, string> = {
    small_business: "sb",
    small_business_sb: "sb",
    disabled_veteran_business_enterprise: "dvbe",
    woman_owned_business: "wbe",
    minority_owned_business: "mbe",
    disadvantaged_business_enterprise: "dbe",
    local_business_enterprise: "lbe",
    "8_a": "8a",
    "8a_business_development": "8a",
    service_disabled_veteran_owned_small_business: "sdvosb",
    woman_owned_small_business: "wosb",
    iso_9001: "iso_9001",
    iso_9001_2015: "iso_9001",
  };
  return aliases[norm] ?? norm;
}

// ---------------------------------------------------------------------------
// Stage 2/3 — Range + semantic scorers
// ---------------------------------------------------------------------------

// Specialty = exact NAICS overlap between the user's onboarding picks and
// the RFP's NAICS codes. Onboarding's specialty step populates
// profile.naicsCodes via three paths (explicit catalog picks, exact title
// matches, and Haiku-inferred free-text — see lib/profile-naics.ts), so
// profile.naicsCodes IS the user's specialty list. A hit means "you
// specifically chose this code as work you want," distinct from Capability
// which scores substitutability across related codes via the matrix.
//
// On no overlap we return neutral (null score) so this row is dropped from
// the weighted average — specialty is a preference boost when present, not
// a penalty when absent.
function scoreSpecialty(
  profile: FullProfile,
  rfp: RfpCacheRow,
): CategoryBreakdown {
  const profileCodes = profile.naicsCodes ?? [];
  const rfpCodes = rfp.naicsCodes ?? [];
  if (profileCodes.length === 0) {
    return neutral("Specialty", "No NAICS specialties on profile.");
  }
  if (rfpCodes.length === 0) {
    return neutral("Specialty", "RFP has no NAICS classification.");
  }

  const rfpSet = new Set(rfpCodes);
  const overlap = profileCodes.filter((c) => rfpSet.has(c));
  if (overlap.length === 0) {
    return neutral("Specialty", "No direct NAICS overlap with your specialties.");
  }

  const code = overlap[0];
  const title = NAICS_MAP[code] ?? code;
  const extra = overlap.length > 1 ? ` (+${overlap.length - 1} more)` : "";
  return {
    category: "Specialty",
    status: "strong",
    score: 1.0,
    weight: WEIGHTS.specialty,
    detail: `Direct specialty match on NAICS ${code} (${title})${extra}.`,
    rfpPhrase: `${code} ${title}`,
    profileClaim: code,
  };
}

// Capability = NAICS-substitutes fit. Replaced the pre-2026-05-26 regex
// bag-of-tokens scorer, which used the polluted rfp.capabilities[] field
// (~32% wrong tags from over-broad regex patterns). The new scorer reads
// the LLM-tagged + Sonnet-audited rfp.naics_codes plus the hand-curated
// substitutes matrix at data/naics-substitutes.json.
//
// Score: for each profile NAICS code, find its best match against the
// RFP's primary NAICS (weighted 2x) AND the best match against any RFP
// secondary NAICS (weighted 1x). Then combine: primary_best * 0.75 +
// secondary_best * 0.25. Captures the intuition that matching the prime
// scope dominates but a sub-trade match still earns credit.
function scoreCapability(
  profile: FullProfile,
  rfp: RfpCacheRow,
): CategoryBreakdown {
  const profileCodes = profile.naicsCodes ?? [];
  const rfpCodes = rfp.naicsCodes ?? [];
  if (profileCodes.length === 0) {
    return neutral(
      "Capability",
      "Add NAICS industries to your profile to enable capability matching.",
    );
  }
  if (rfpCodes.length === 0) {
    return neutral("Capability", "RFP has no NAICS classification yet.");
  }

  const rfpPrimary = rfpCodes[0];
  const rfpSecondaries = rfpCodes.slice(1);

  // Best primary match across vendor's codes, with the matched details so
  // we can cite which substitute fired and why.
  let bestPrimary = { vendor: "", sim: 0, rationale: undefined as string | undefined };
  for (const vc of profileCodes) {
    const r = lookupNaicsSimilarityDetailed(vc, rfpPrimary);
    if (r && r.sim > bestPrimary.sim) {
      bestPrimary = { vendor: vc, sim: r.sim, rationale: r.rationale };
    }
  }

  // Best secondary match — only meaningful if the RFP has secondaries.
  let bestSecondary = { vendor: "", rfp: "", sim: 0 };
  for (const vc of profileCodes) {
    for (const rs of rfpSecondaries) {
      const r = lookupNaicsSimilarityDetailed(vc, rs);
      if (r && r.sim > bestSecondary.sim) {
        bestSecondary = { vendor: vc, rfp: rs, sim: r.sim };
      }
    }
  }

  const combined = bestPrimary.sim * 0.75 + bestSecondary.sim * 0.25;
  const status: CategoryStatus =
    combined >= 0.85 ? "strong"
    : combined >= 0.55 ? "partial"
    : combined >= 0.30 ? "weak"
    : "missing";

  // Build the citation. Prefer the primary match since it dominates the
  // score; fall back to secondary if primary returned nothing.
  const primaryTitle = NAICS_MAP[rfpPrimary] ?? rfpPrimary;
  const detail = bestPrimary.sim > 0
    ? `Your NAICS ${bestPrimary.vendor} (${NAICS_MAP[bestPrimary.vendor] ?? bestPrimary.vendor}) substitutes for required ${rfpPrimary} (${primaryTitle}) at ${(bestPrimary.sim * 100).toFixed(0)}%${bestPrimary.rationale ? ` — ${bestPrimary.rationale}` : ""}.`
    : bestSecondary.sim > 0
      ? `Partial fit via secondary NAICS — your ${bestSecondary.vendor} substitutes for the RFP's ${bestSecondary.rfp} at ${(bestSecondary.sim * 100).toFixed(0)}%.`
      : `None of your industries (${profileCodes.length}) substitute for required ${rfpPrimary} (${primaryTitle}).`;

  return {
    category: "Capability",
    status,
    score: status === "missing" ? 0.1 : Math.max(0, Math.min(1, combined)),
    weight: WEIGHTS.capability,
    detail,
    rfpPhrase: `${rfpPrimary} ${primaryTitle}`,
    profileClaim: bestPrimary.vendor || bestSecondary.vendor || undefined,
  };
}

// Sub-track variant of scoreCapability. Same per-pair similarity math but:
//   - Considers ALL RFP NAICS equally (not weighted toward primary), since
//     a sub vendor matches a single trade slice
//   - Looser status thresholds (≥0.50 strong, ≥0.30 partial, ≥0.15 weak)
//     so a vendor that's only a partial fit for a sub slot still surfaces
function scoreCapabilityForSub(
  profile: FullProfile,
  rfp: RfpCacheRow,
): CategoryBreakdown {
  const profileCodes = profile.naicsCodes ?? [];
  const rfpCodes = rfp.naicsCodes ?? [];
  if (profileCodes.length === 0) {
    return neutral("Capability", "No NAICS industries on profile.");
  }
  if (rfpCodes.length === 0) {
    return neutral("Capability", "RFP has no NAICS classification.");
  }

  let best = { vendor: "", rfp: "", sim: 0, rationale: undefined as string | undefined };
  for (const vc of profileCodes) {
    for (const rc of rfpCodes) {
      const r = lookupNaicsSimilarityDetailed(vc, rc);
      if (r && r.sim > best.sim) {
        best = { vendor: vc, rfp: rc, sim: r.sim, rationale: r.rationale };
      }
    }
  }

  const status: CategoryStatus =
    best.sim >= 0.50 ? "strong"
    : best.sim >= 0.30 ? "partial"
    : best.sim >= 0.15 ? "weak"
    : "missing";

  const rfpTitle = NAICS_MAP[best.rfp] ?? best.rfp;
  const vendorTitle = NAICS_MAP[best.vendor] ?? best.vendor;
  const detail = best.sim > 0
    ? `As sub: your NAICS ${best.vendor} (${vendorTitle}) covers the RFP's ${best.rfp} (${rfpTitle}) at ${(best.sim * 100).toFixed(0)}%${best.rationale ? ` — ${best.rationale}` : ""}.`
    : `None of your industries overlap any RFP NAICS.`;

  return {
    category: "Capability",
    status,
    score: status === "missing" ? 0 : Math.max(0, Math.min(1, best.sim)),
    weight: WEIGHTS.capability,
    detail,
    profileClaim: best.vendor || undefined,
  };
}

function scoreScope(profile: FullProfile, rfp: RfpCacheRow): CategoryBreakdown {
  const val = rfp.estimatedValueUsd;
  if (!val) {
    return neutral("Scope", "RFP value not disclosed.");
  }
  const min = profile.scopeMinUsd;
  const max = profile.scopeMaxUsd;
  if (!min && !max) {
    return neutral("Scope", "No scope preferences set on profile.");
  }

  if (min && val < min * 0.5) {
    return {
      category: "Scope",
      status: "weak",
      score: 0.2,
      weight: WEIGHTS.scope,
      detail: `RFP value ($${val.toLocaleString()}) is far below your minimum ($${min.toLocaleString()}).`,
    };
  }
  if (max && val > max * 1.5) {
    return {
      category: "Scope",
      status: "weak",
      score: 0.2,
      weight: WEIGHTS.scope,
      detail: `RFP value ($${val.toLocaleString()}) is far above your max ($${max.toLocaleString()}).`,
    };
  }
  const inBand = (!min || val >= min) && (!max || val <= max);
  if (inBand) {
    return {
      category: "Scope",
      status: "strong",
      score: 1.0,
      weight: WEIGHTS.scope,
      detail: `RFP value falls within your scope band.`,
    };
  }
  return {
    category: "Scope",
    status: "partial",
    score: 0.6,
    weight: WEIGHTS.scope,
    detail: `RFP value is just outside your scope band (within 1.5×).`,
  };
}

function scoreDuration(profile: FullProfile, rfp: RfpCacheRow): CategoryBreakdown {
  // Without a durationMonths field on rfp_cache we infer from text. Best effort.
  const months = parseDurationMonths(rfp);
  if (months == null) {
    return neutral("Duration", "RFP duration not stated.");
  }
  const pref = profile.durationPref;
  if (!pref) return neutral("Duration", "No duration preference set.");

  if (pref === "short" && months <= 6) return strong("Duration", "Short job, matches your preference.", 1.0);
  if (pref === "short" && months <= 12) return partial("Duration", "Slightly longer than ideal.", 0.6);
  if (pref === "short") return weak("Duration", "Longer than your preference.");
  if (pref === "retention_ok") return strong("Duration", "Any duration accepted.", 1.0);
  return strong("Duration", "Any duration accepted.", 1.0);
}

function parseDurationMonths(rfp: RfpCacheRow): number | null {
  const raw = rfp.raw as Record<string, unknown> | null | undefined;
  const dur = raw && typeof raw === "object" && "duration_months" in raw
    ? raw.duration_months
    : undefined;
  if (typeof dur === "number") return dur;
  // Try to parse from the description.
  if (rfp.description) {
    const m = rfp.description.match(/(\d+)\s*(?:-|to)?\s*(\d+)?\s*month/i);
    if (m) return parseInt(m[1], 10);
    const yr = rfp.description.match(/(\d+)\s*year/i);
    if (yr) return parseInt(yr[1], 10) * 12;
  }
  return null;
}

function scoreComplexity(profile: FullProfile, rfp: RfpCacheRow): CategoryBreakdown {
  // Tier inferred from deliverables length + naics breadth.
  const tier = inferComplexityTier(rfp);
  if (!tier) return neutral("Complexity", "Insufficient signal to infer complexity.");
  const pref = profile.complexityPref;
  if (!pref) return neutral("Complexity", "No complexity preference set.");

  if (pref === "simple_only" && tier === "simple") return strong("Complexity", "Simple job, fits your preference.", 1.0);
  if (pref === "simple_only") return { category: "Complexity", status: "weak", score: 0.1, weight: WEIGHTS.complexity, detail: `${tier} job, you prefer simple-only.` };
  if (pref === "any_with_subs") return strong("Complexity", "Any complexity ok with subs.", 1.0);
  // "any" means the user opted in to every tier — credit it as a full match.
  if (pref === "any") return strong("Complexity", `${tier} complexity, fits your "any" preference.`, 1.0);
  return partial("Complexity", `${tier} complexity, you said any.`, 0.7);
}

function inferComplexityTier(rfp: RfpCacheRow): "simple" | "moderate" | "complex" | null {
  const deliverables = rfp.deliverables?.length ?? 0;
  const naics = rfp.naicsCodes?.length ?? 0;
  if (deliverables === 0 && naics === 0) return null;
  const score = deliverables + naics * 2;
  if (score >= 8) return "complex";
  if (score >= 3) return "moderate";
  return "simple";
}

function scoreAgency(profile: FullProfile, rfp: RfpCacheRow): CategoryBreakdown {
  if (!rfp.agency) return neutral("Agency", "RFP missing agency.");
  if (profile.agencyRelationships.length === 0) {
    return neutral("Agency", "No agency history on profile.");
  }
  const agencyLower = rfp.agency.toLowerCase();
  const matches = profile.agencyRelationships.filter(
    (r) =>
      agencyLower.includes(r.agencyDisplay.toLowerCase()) ||
      agencyLower.includes(r.agencyCanonical.toLowerCase()) ||
      r.agencyDisplay.toLowerCase().includes(agencyLower),
  );
  if (matches.length === 0) return neutral("Agency", "No prior work with this agency.");

  matches.sort((a, b) => b.strength - a.strength);
  const best = matches[0];
  if (best.role === "prime" && best.strength >= 4) {
    return {
      category: "Agency",
      status: "strong",
      score: 1.0,
      weight: WEIGHTS.agency,
      detail: `Strong prime relationship with ${best.agencyDisplay}.`,
      profileClaim: `${best.agencyDisplay} (prime, strength ${best.strength})`,
    };
  }
  if (best.role === "prime") {
    return partial("Agency", `Prior prime work with ${best.agencyDisplay}.`, 0.7, best.agencyDisplay);
  }
  if (best.role === "sub") {
    return partial("Agency", `Prior sub work with ${best.agencyDisplay}.`, 0.5, best.agencyDisplay);
  }
  return weak("Agency", `Some exposure to ${best.agencyDisplay}.`);
}

function scoreLocation(profile: FullProfile, rfp: RfpCacheRow): CategoryBreakdown {
  if (!rfp.location) return neutral("Location", "RFP missing location.");
  if (profile.workAreas.length === 0) {
    return neutral("Location", "No work areas defined on profile.");
  }
  const loc = rfp.location.toLowerCase();
  const exact = profile.workAreas.find((a) => loc.includes(a.name.toLowerCase()));
  if (exact) {
    return {
      category: "Location",
      status: "strong",
      score: 1.0,
      weight: WEIGHTS.location,
      detail: `${rfp.location} is in your work areas (${exact.name}).`,
      profileClaim: `${exact.name} (${exact.kind})`,
    };
  }
  // Loose CA fallback — both sides mention CA somewhere.
  if (loc.includes("california") || loc.includes(", ca")) {
    const hasCa = profile.workAreas.some(
      (a) => a.name.toUpperCase() === "CA" || a.name.toLowerCase().includes("california"),
    );
    if (hasCa) return weak("Location", "Both in California.");
  }
  return { category: "Location", status: "missing", score: 0, weight: WEIGHTS.location, detail: `${rfp.location} not in any of your work areas.` };
}

// scoreNaicsOverlap (origin/main 4fe4941) was deleted as part of the
// merge — its direct-overlap logic is now a special case of scoreCapability
// (exact code match returns sim=1.0 from the substitutes matrix, with the
// added benefit that partial/related codes also score via the curated
// weights instead of returning 0).

// ---------------------------------------------------------------------------
// Stage 4 — Soft cert bonus (spec § 9.5)
// ---------------------------------------------------------------------------

function softCertBonus(profile: FullProfile, rfp: RfpCacheRow): number {
  const raw = rfp.raw as Record<string, unknown> | null | undefined;
  const preferred =
    raw && typeof raw === "object" && Array.isArray(raw.preferred_certs)
      ? (raw.preferred_certs as string[])
      : [];
  if (preferred.length === 0) return 0;
  const held = new Set(profile.certifications.filter((c) => c.kind === "soft").map((c) => c.canonicalId));
  const hits = preferred.map(canonicalizeCert).filter((c): c is string => !!c).filter((c) => held.has(c));
  return Math.min(0.15, hits.length * 0.05);
}

// ---------------------------------------------------------------------------
// Stage 5 — Incumbent state machine (spec § 10)
// ---------------------------------------------------------------------------

function computeIncumbentState(rfp: RfpCacheRow): IncumbentStateInfo {
  // 1. Cal eProcure live path: LLM-extracted incumbent_vendor from RFP text.
  if (rfp.incumbentVendor) {
    return {
      state: "likely",
      confidence: 0.85,
      source: "text_extraction",
      namedVendor: rfp.incumbentVendor,
      contractEnd: rfp.incumbentContractEnd ?? undefined,
    };
  }

  // 2-4. PlanetBids award-history paths. The rfp_bidders join is not yet
  // wired into this read path (spec § 10.4 — depends on vendor fingerprint
  // pipeline). Stubbed deliberately: returning 'unknown' here is correct
  // behaviour for any source we don't currently have data for, and keeps
  // the matcher from inventing precision it doesn't have.
  //
  // TODO: once webscraping populates rfpBidders, look up award history by
  // (rfp.agency, similar capabilities) and run the n=2 recent-repeat and
  // distinct-winners-n=3 checks per spec § 10.1.

  return { state: "unknown", confidence: null, source: "none" };
}

function incumbentMultiplier(state: IncumbentStateInfo): number {
  if (state.state !== "likely" || state.confidence == null) return 1.0;
  // 80% conf → 0.6×, 90% conf → 0.55× (spec § 10.1)
  return 1.0 - 0.5 * state.confidence;
}

// ---------------------------------------------------------------------------
// Data quality summary (spec § 9.8 / § 2 table)
// ---------------------------------------------------------------------------

function computeDataQuality(rfp: RfpCacheRow): DataQuality {
  const hasPdf =
    (rfp.licensesRequired && rfp.licensesRequired.length > 0) ||
    (rfp.certificationsRequired && rfp.certificationsRequired.length > 0) ||
    (rfp.deliverables && rfp.deliverables.length > 0);
  const hasMarket = (rfp.prospectiveBidderCount ?? 0) > 0 || (rfp.bidCount ?? 0) > 0;

  let coverage: DataQuality["coverage"];
  if (hasPdf && hasMarket) coverage = "full";
  else if (hasPdf) coverage = "requirements_only";
  else if (hasMarket) coverage = "market_intel_only";
  else coverage = "thin";

  return {
    sourceId: rfp.sourceId,
    hasPdfExtraction: !!hasPdf,
    hasMarketIntel: hasMarket,
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Stage 6 — Sub-on-prime track (spec § 9.7)
// ---------------------------------------------------------------------------

function scoreAsSub(
  profile: FullProfile,
  rfp: RfpCacheRow,
): { eligible: boolean; score: number; breakdown: CategoryBreakdown[] } {
  // Sub eligibility is looser than prime — subs aren't the entity holding
  // the prime contract, so prime-only gates (gov experience, set-aside
  // lockouts) don't apply. Sub eligibility is driven by NAICS overlap
  // (any RFP code at sim ≥ 0.3 via the substitutes matrix).
  //
  // Sub-track weighting: capability (NAICS) gets the largest share because
  // the sub-eligibility floor is sim ≥ 0.3 against any RFP code (vs ≥ 0.5
  // against the primary for prime). Location stays important since subs
  // are typically local. Specialty contributes when there's a direct NAICS
  // pick overlap with the RFP.
  const subCapability = { ...scoreCapabilityForSub(profile, rfp), weight: 0.4 };
  const subSpecialty = { ...scoreSpecialty(profile, rfp), weight: 0.25 };
  const subLocation = { ...scoreLocation(profile, rfp), weight: 0.25 };
  const subAgency = { ...scoreAgency(profile, rfp), weight: 0.1 };
  const breakdown = [subCapability, subSpecialty, subLocation, subAgency];

  const score = clamp01to100(aggregateWeighted(breakdown));
  // Eligible if any scored category is at least partial — the sub track
  // is permissive on purpose, designed to surface "you could play here"
  // rather than gatekeep.
  const eligible = breakdown.some((b) => b.status === "strong" || b.status === "partial");
  return { eligible, score, breakdown };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function aggregateWeighted(rows: CategoryBreakdown[]): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const r of rows) {
    if (r.score == null) continue;
    weightedSum += r.score * r.weight;
    totalWeight += r.weight;
  }
  if (totalWeight === 0) return 0;
  // Re-normalize to the full 0..1 range so unknown categories don't depress
  // the final score artificially.
  return weightedSum / totalWeight;
}

function clamp01to100(x: number): number {
  return Math.round(Math.max(0, Math.min(1, x)) * 100);
}

function tierFor(score: number): Tier {
  if (score >= 75) return "excellent";
  if (score >= 55) return "strong";
  if (score >= 35) return "moderate";
  if (score >= 15) return "low";
  return "minimal";
}

// ---------------------------------------------------------------------------
// Tiny inline factories for breakdown rows — keeps the scorers above terse.
// ---------------------------------------------------------------------------

function neutral(category: string, detail: string): CategoryBreakdown {
  return { category, status: "neutral", score: null, weight: WEIGHTS[category.toLowerCase()] ?? 0, detail };
}
function strong(category: string, detail: string, score: number): CategoryBreakdown {
  return { category, status: "strong", score, weight: WEIGHTS[category.toLowerCase()] ?? 0, detail };
}
function partial(category: string, detail: string, score: number, profileClaim?: string): CategoryBreakdown {
  return { category, status: "partial", score, weight: WEIGHTS[category.toLowerCase()] ?? 0, detail, profileClaim };
}
function weak(category: string, detail: string): CategoryBreakdown {
  return { category, status: "weak", score: 0.2, weight: WEIGHTS[category.toLowerCase()] ?? 0, detail };
}
