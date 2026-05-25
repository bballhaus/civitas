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
import { cosine } from "@/lib/embeddings";

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

// Weights sum to 1.0. Any category with a null score is dropped from both
// numerator AND denominator so unknown categories don't penalize the total.
//
// NAICS overlap (new) replaces the previous `description` bag-of-tokens
// scorer, which was double-counting against the RFP embedding (the
// description is already part of buildRfpEmbeddingText) and offered almost
// no semantic value on its own. Specialty was rebalanced down to 0.20 and
// capability up to 0.20 so that semantic capability matching — now
// augmented by NAICS titles in the RFP embedding text — pulls more weight.
const WEIGHTS: Record<string, number> = {
  specialty: 0.2,
  capability: 0.2,
  naics: 0.1,
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
    scoreSpecialty(profile, rfp, dataQuality),
    scoreCapability(profile, rfp, dataQuality),
    scoreNaicsOverlap(profile, rfp),
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
  const sub = scoreAsSub(profile, rfp, dataQuality);

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

function semanticConfidence(rfp: RfpCacheRow, dq: DataQuality): number {
  if (dq.coverage === "full") return 1.0;
  if (dq.coverage === "requirements_only") return 0.85;
  if (rfp.description) return 0.7;
  return 0.6;
}

function scoreSpecialty(
  profile: FullProfile,
  rfp: RfpCacheRow,
  dq: DataQuality,
): CategoryBreakdown {
  if (profile.specialties.length === 0) {
    return neutral("Specialty", "Add specialties to your profile to enable semantic match.");
  }

  // Literal-first short-circuit. Same problem shape as scoreCapability —
  // cosine compares a single specialty phrase against the whole-RFP vector,
  // so even a definitive textual hit lands well below 1.0. If your
  // specialty appears literally in the RFP title or in its structured
  // capabilities[] array, that's a strong signal — bypass cosine and
  // return strong directly.
  const titleLower = rfp.title.toLowerCase();
  const titleHit = profile.specialties.find((s) =>
    titleLower.includes(s.value.toLowerCase()),
  );
  if (titleHit) {
    return {
      category: "Specialty",
      status: "strong",
      score: 1.0,
      weight: WEIGHTS.specialty,
      detail: `RFP title references your specialty: "${titleHit.value}".`,
      rfpPhrase: rfp.title,
      profileClaim: titleHit.value,
    };
  }
  const rfpCapsLower = (rfp.capabilities ?? []).map((s) => s.toLowerCase());
  if (rfpCapsLower.length > 0) {
    const capHit = profile.specialties.find((s) =>
      rfpCapsLower.some((c) => c.includes(s.value.toLowerCase())),
    );
    if (capHit) {
      return {
        category: "Specialty",
        status: "strong",
        score: 1.0,
        weight: WEIGHTS.specialty,
        detail: `RFP capabilities reference your specialty: "${capHit.value}".`,
        rfpPhrase: rfp.title,
        profileClaim: capHit.value,
      };
    }
  }

  if (!rfp.embedding) {
    // Without an RFP embedding we can't run semantic. Fall back to substring
    // match on title/description so the score is non-zero when there's a
    // clear textual hit.
    const textBag = `${rfp.title} ${rfp.description ?? ""}`.toLowerCase();
    const hits = profile.specialties.filter((s) =>
      textBag.includes(s.value.toLowerCase()),
    );
    if (hits.length > 0) {
      return {
        category: "Specialty",
        status: "partial",
        score: 0.6,
        weight: WEIGHTS.specialty,
        detail: `Title/description references your specialty (no embedding yet).`,
        rfpPhrase: rfp.title,
        profileClaim: hits[0].value,
      };
    }
    return neutral("Specialty", "No embedding available for this RFP yet.");
  }

  const withEmb = profile.specialties.filter((s) => !!s.embedding);
  if (withEmb.length === 0) {
    return neutral(
      "Specialty",
      "Specialty embeddings haven't been generated yet (Voyage backfill pending).",
    );
  }

  // pgvector stores as number[] already; cosine works directly.
  const rfpVec = rfp.embedding as unknown as number[];
  const sims = withEmb.map((s) => ({
    s,
    sim: cosine(s.embedding as unknown as number[], rfpVec),
  }));
  sims.sort((a, b) => b.sim - a.sim);
  const best = sims[0];
  const adjusted = best.sim * semanticConfidence(rfp, dq);

  const status: CategoryStatus =
    adjusted >= 0.75 ? "strong" : adjusted >= 0.55 ? "partial" : adjusted >= 0.35 ? "weak" : "missing";

  return {
    category: "Specialty",
    status,
    score: status === "missing" ? 0.1 : Math.max(0, Math.min(1, adjusted)),
    weight: WEIGHTS.specialty,
    detail: `Closest specialty match: "${best.s.value}" (similarity ${best.sim.toFixed(2)}, adjusted for source quality).`,
    rfpPhrase: pickRfpPhrase(rfp),
    profileClaim: best.s.value,
  };
}

function scoreCapability(
  profile: FullProfile,
  rfp: RfpCacheRow,
  dq: DataQuality,
): CategoryBreakdown {
  if (profile.capabilities.length === 0) {
    return neutral("Capability", "No capabilities on file.");
  }

  // Literal-first short-circuit. Embedding cosine compares one capability
  // string against the whole-RFP vector, so even an exact textual hit lands
  // around 0.55–0.65 — misleading when the RFP explicitly lists the same
  // capability. If any of the user's capabilities matches an entry in the
  // RFP's structured capabilities[] (case-insensitive), score it strong
  // directly and skip cosine.
  const rfpCapsLower = (rfp.capabilities ?? []).map((s) => s.toLowerCase());
  if (rfpCapsLower.length > 0) {
    const literalHit = profile.capabilities.find((c) =>
      rfpCapsLower.includes(c.value.toLowerCase()),
    );
    if (literalHit) {
      return {
        category: "Capability",
        status: "strong",
        score: 1.0,
        weight: WEIGHTS.capability,
        detail: `Exact capability match: "${literalHit.value}".`,
        profileClaim: literalHit.value,
      };
    }
  }

  if (!rfp.embedding) {
    const textBag = `${rfp.title} ${rfp.description ?? ""} ${rfp.capabilities?.join(" ") ?? ""}`.toLowerCase();
    const hits = profile.capabilities.filter((c) =>
      textBag.includes(c.value.toLowerCase()),
    );
    if (hits.length > 0) {
      return {
        category: "Capability",
        status: "partial",
        score: 0.5,
        weight: WEIGHTS.capability,
        detail: `Textual match on ${hits.length} of your capabilities.`,
        profileClaim: hits[0].value,
      };
    }
    return neutral("Capability", "No textual overlap.");
  }

  const withEmb = profile.capabilities.filter((c) => !!c.embedding);
  if (withEmb.length === 0) {
    return neutral("Capability", "Capability embeddings pending.");
  }
  const rfpVec = rfp.embedding as unknown as number[];
  const sims = withEmb.map((c) => ({ c, sim: cosine(c.embedding as unknown as number[], rfpVec) }));
  sims.sort((a, b) => b.sim - a.sim);
  const best = sims[0];
  const adjusted = best.sim * semanticConfidence(rfp, dq);

  // Capability thresholds slightly looser than specialty (spec § 9.4 note).
  const status: CategoryStatus =
    adjusted >= 0.65 ? "strong" : adjusted >= 0.45 ? "partial" : adjusted >= 0.25 ? "weak" : "missing";

  return {
    category: "Capability",
    status,
    score: status === "missing" ? 0.1 : Math.max(0, Math.min(1, adjusted)),
    weight: WEIGHTS.capability,
    detail: `Closest capability: "${best.c.value}" (similarity ${best.sim.toFixed(2)}).`,
    profileClaim: best.c.value,
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

// Direct NAICS code overlap — hard signal, not semantically dampened. When
// both sides expose NAICS we score by coverage (matches / rfp codes) so
// covering all of an RFP's codes maxes the component. The official NAICS
// titles are also folded into the RFP embedding text (see embeddings.ts) so
// semantic capability matching benefits even when the contractor hasn't
// added NAICS to their profile — but this scorer rewards explicit overlap.
function scoreNaicsOverlap(profile: FullProfile, rfp: RfpCacheRow): CategoryBreakdown {
  const rfpCodes = rfp.naicsCodes ?? [];
  const profileCodes = profile.naicsCodes ?? [];
  if (rfpCodes.length === 0) {
    return neutral("NAICS", "RFP doesn't list NAICS codes.");
  }
  if (profileCodes.length === 0) {
    return neutral(
      "NAICS",
      "Add NAICS codes to your profile to score direct overlap with RFPs.",
    );
  }
  const profileSet = new Set(profileCodes);
  const matches = rfpCodes.filter((c) => profileSet.has(c));
  if (matches.length === 0) {
    return {
      category: "NAICS",
      status: "missing",
      score: 0,
      weight: WEIGHTS.naics,
      detail: `No code overlap (RFP cites ${rfpCodes.join(", ")}).`,
      rfpPhrase: rfpCodes.join(", "),
    };
  }
  const coverage = matches.length / rfpCodes.length;
  const status: CategoryStatus =
    coverage >= 0.66 ? "strong" : coverage >= 0.33 ? "partial" : "weak";
  // Floor at 0.6 so even a single overlap is a meaningful score — direct
  // NAICS code agreement is high-confidence industry alignment.
  const score = Math.max(0.6, coverage);
  return {
    category: "NAICS",
    status,
    score,
    weight: WEIGHTS.naics,
    detail: `${matches.length} of ${rfpCodes.length} RFP NAICS codes match your profile (${matches.join(", ")}).`,
    rfpPhrase: rfpCodes.join(", "),
    profileClaim: matches.join(", "),
  };
}

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
  dq: DataQuality,
): { eligible: boolean; score: number; breakdown: CategoryBreakdown[] } {
  // If the user has zero specialties, they can't credibly sub. Otherwise
  // sub eligibility is much looser than prime — subs aren't the entity
  // holding the prime contract, so prime-only gates (gov experience,
  // set-aside lockouts) don't apply.
  if (profile.specialties.length === 0) {
    return { eligible: false, score: 0, breakdown: [] };
  }

  // Loosened categories: specialty weight up, agency weight down, scope/
  // duration kept neutral (subs don't drive these). Reuses scorers for
  // consistency; weights are local to the sub track.
  const subSpecialty = { ...scoreSpecialty(profile, rfp, dq), weight: 0.45 };
  const subCapability = { ...scoreCapability(profile, rfp, dq), weight: 0.2 };
  const subLocation = { ...scoreLocation(profile, rfp), weight: 0.2 };
  const subAgency = { ...scoreAgency(profile, rfp), weight: 0.05 };
  const subNaics = { ...scoreNaicsOverlap(profile, rfp), weight: 0.1 };
  const breakdown = [subSpecialty, subCapability, subLocation, subAgency, subNaics];

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

function pickRfpPhrase(rfp: RfpCacheRow): string {
  if (rfp.deliverables && rfp.deliverables.length > 0) return rfp.deliverables[0];
  if (rfp.description) return rfp.description.slice(0, 140);
  return rfp.title;
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
