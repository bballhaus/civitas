// Behavioral tests for the v2 matcher. Focus on the spec's invariants —
// empty fields treated as unknown, hard gates routing to sub track, scope
// banding, incumbent multiplier — rather than exact score values, which
// will drift as we tune weights.
//
// Run with: npx tsx --test src/lib/__tests__/matching-v2.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchV2 } from "../matching-v2";
import type { FullProfile } from "@/db/queries/profile";
import type { RfpCacheRow } from "@/db/schema";

// ---------------------------------------------------------------------------
// Factories — keep tests skinny by mutating from a baseline
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<FullProfile> = {}): FullProfile {
  return {
    userId: "u1",
    companyName: "Acme Concrete",
    yearFounded: 2015,
    employeeBand: "11-50",
    website: null,
    scopeMinUsd: 100_000,
    scopeMaxUsd: 5_000_000,
    durationPref: "any",
    complexityPref: "any",
    primeVsSub: "open_to_sub",
    govExperience: "local",
    vendorFingerprint: null,
    vendorResolvedAt: null,
    completenessScore: 80,
    onboardedAt: new Date(),
    embeddingUpdatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    specialties: [],
    capabilities: [],
    licenses: [],
    certifications: [],
    workAreas: [],
    agencyRelationships: [],
    ...overrides,
  };
}

function makeRfp(overrides: Partial<RfpCacheRow> = {}): RfpCacheRow {
  return {
    id: "rfp-1",
    sourceId: "caleprocure",
    title: "Sidewalk and curb ramp installation",
    description: "City-wide sidewalk and curb ramp installation per ADA standards.",
    agency: "Caltrans District 4",
    location: "San Francisco, CA",
    deadline: new Date("2026-08-01"),
    estimatedValueUsd: 750_000,
    capabilities: ["concrete flatwork", "ADA compliance"],
    naicsCodes: ["237310"],
    certificationsRequired: [],
    licensesRequired: [],
    setAsideLockout: [],
    deliverables: ["Curb ramp installation", "Sidewalk repair"],
    requiresPastGovExp: null,
    incumbentVendor: null,
    incumbentContractEnd: null,
    prospectiveBidderCount: null,
    bidCount: null,
    bidAmountsCents: null,
    winningBidCents: null,
    winningVendorFingerprint: null,
    embedding: null,
    raw: null,
    refreshedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("empty RFP requirement fields do not fire hard gates", () => {
  // PlanetBids case: licenses_required is [] because the PDF is gated, NOT
  // because no license is needed. The matcher must treat this as unknown.
  const profile = makeProfile({ licenses: [] });
  const rfp = makeRfp({ licensesRequired: [] });
  const result = matchV2(profile, rfp);
  assert.equal(result.primeEligible, true);
  assert.equal(result.gateFailures.length, 0);
});

test("non-empty license requirement disqualifies a profile that doesn't hold it", () => {
  const profile = makeProfile({ licenses: [] });
  const rfp = makeRfp({ licensesRequired: ["A"] });
  const result = matchV2(profile, rfp);
  assert.equal(result.primeEligible, false);
  assert.ok(result.gateFailures.some((f) => f.includes("Missing license")));
});

test("license held satisfies the gate", () => {
  const profile = makeProfile({
    licenses: [{
      id: "l1", userId: "u1", licenseClass: "A", licenseNumber: null,
      expiresOn: null, verified: false, createdAt: new Date(),
    }],
  });
  const rfp = makeRfp({ licensesRequired: ["Class A"] });
  const result = matchV2(profile, rfp);
  assert.equal(result.primeEligible, true);
});

test("hard work area blocks RFP outside the lock", () => {
  const profile = makeProfile({
    workAreas: [{
      id: "w1", userId: "u1", kind: "city", name: "San Diego",
      isHard: true, radiusMiles: null, createdAt: new Date(),
    }],
  });
  const rfp = makeRfp({ location: "Sacramento, CA" });
  const result = matchV2(profile, rfp);
  assert.equal(result.primeEligible, false);
  assert.ok(result.gateFailures.some((f) => f.toLowerCase().includes("work area")));
});

test("past gov experience gate fires only when required", () => {
  const profile = makeProfile({ govExperience: "none" });
  const noGate = matchV2(profile, makeRfp({ requiresPastGovExp: null }));
  assert.equal(noGate.primeEligible, true);

  const withGate = matchV2(profile, makeRfp({ requiresPastGovExp: true }));
  assert.equal(withGate.primeEligible, false);
});

test("scope band — in-range RFP scores strong", () => {
  const result = matchV2(makeProfile(), makeRfp({ estimatedValueUsd: 1_000_000 }));
  const scope = result.breakdown.find((b) => b.category === "Scope")!;
  assert.equal(scope.status, "strong");
});

test("scope band — RFP far below minimum scores weak", () => {
  const result = matchV2(makeProfile(), makeRfp({ estimatedValueUsd: 5_000 }));
  const scope = result.breakdown.find((b) => b.category === "Scope")!;
  assert.equal(scope.status, "weak");
});

test("scope is neutral when RFP value is unknown", () => {
  const result = matchV2(makeProfile(), makeRfp({ estimatedValueUsd: null }));
  const scope = result.breakdown.find((b) => b.category === "Scope")!;
  assert.equal(scope.status, "neutral");
  assert.equal(scope.score, null);
});

test("incumbent_vendor flips state to 'likely' and trims win probability", () => {
  const result = matchV2(
    makeProfile(),
    makeRfp({ incumbentVendor: "Existing Vendor Inc.", estimatedValueUsd: 750_000 }),
  );
  assert.equal(result.incumbent.state, "likely");
  assert.equal(result.incumbent.namedVendor, "Existing Vendor Inc.");
  // Win probability must be strictly lower than score when incumbent likely.
  assert.ok(result.winProbability < result.score);
});

test("no incumbent signal yields 'unknown' state with no multiplier", () => {
  const result = matchV2(makeProfile(), makeRfp({ incumbentVendor: null }));
  assert.equal(result.incumbent.state, "unknown");
  assert.equal(result.winProbability, result.score);
});

test("data_quality coverage classification", () => {
  const full = matchV2(
    makeProfile(),
    makeRfp({
      deliverables: ["A", "B"],
      prospectiveBidderCount: 5,
    }),
  );
  assert.equal(full.dataQuality.coverage, "full");

  const requirementsOnly = matchV2(
    makeProfile(),
    makeRfp({
      deliverables: ["A"],
      prospectiveBidderCount: null,
    }),
  );
  assert.equal(requirementsOnly.dataQuality.coverage, "requirements_only");

  const marketOnly = matchV2(
    makeProfile(),
    makeRfp({
      deliverables: null,
      prospectiveBidderCount: 5,
    }),
  );
  assert.equal(marketOnly.dataQuality.coverage, "market_intel_only");

  const thin = matchV2(
    makeProfile(),
    makeRfp({ deliverables: null, prospectiveBidderCount: null }),
  );
  assert.equal(thin.dataQuality.coverage, "thin");
});

test("failed prime routes to sub track if specialty match exists", () => {
  const profile = makeProfile({
    specialties: [{
      id: "s1", userId: "u1", value: "concrete flatwork",
      canonicalId: null, weight: "primary", embedding: null,
      createdAt: new Date(),
    }],
    licenses: [],
  });
  const rfp = makeRfp({
    licensesRequired: ["A"],
    title: "Concrete flatwork project",
    description: "Concrete flatwork installation and repair.",
  });
  const result = matchV2(profile, rfp);
  assert.equal(result.primeEligible, false);
  assert.equal(result.subEligible, true);
  assert.ok(result.subTrack.score > 0);
});

test("tier 'not_eligible' when prime gates fail and sub track is empty", () => {
  const profile = makeProfile({ specialties: [], licenses: [] });
  const rfp = makeRfp({ licensesRequired: ["A"] });
  const result = matchV2(profile, rfp);
  assert.equal(result.tier, "not_eligible");
});

test("citations carry RFP phrase and profile claim", () => {
  const profile = makeProfile({
    specialties: [{
      id: "s1", userId: "u1", value: "concrete flatwork installation",
      canonicalId: null, weight: "primary", embedding: null,
      createdAt: new Date(),
    }],
  });
  const rfp = makeRfp({
    title: "concrete flatwork installation downtown",
    description: "concrete flatwork installation downtown",
  });
  const result = matchV2(profile, rfp);
  const spec = result.breakdown.find((b) => b.category === "Specialty")!;
  // No embedding fallback path — should still produce a citation.
  assert.ok(spec.profileClaim, "specialty citation missing profile claim");
});
