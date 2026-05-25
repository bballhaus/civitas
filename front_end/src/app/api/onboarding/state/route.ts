// Onboarding resume + completion state (Architecture-v2 § 5 + § 11).
//
// GET  → tells the client which step to land on (computed from what the
//        profile already has populated) and how complete the profile is.
// POST → marks the profile as fully onboarded (writes profiles.onboarded_at).
//        Called from step 9 ("Done") on the wizard.
//
// Each individual screen persists through its own collection route
// (/api/profile/*), so this endpoint owns resume state only — not per-step
// writes. Spec § 5 lists per-step write targets verbatim.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { profiles } from "@/db/schema";
import {
  getFullProfile,
  refreshCompletenessScore,
} from "@/db/queries/profile";
import { recordEvent } from "@/lib/event-log";
import { refreshProfileEmbeddings, EmbeddingConfigError } from "@/lib/embeddings";

// Maps spec § 5 step numbers to the readiness check that "moves past" that
// step. Step 10 is the explicit completion marker (onboarded_at). Step 4
// (NAICS) is optional and never blocks resume — users who skip it land on
// the next required step.
function computeNextStep(profile: Awaited<ReturnType<typeof getFullProfile>>): number {
  if (!profile) return 1;
  if (profile.onboardedAt) return 10; // already done
  if (!profile.companyName) return 1;
  if (profile.specialties.length === 0) return 2;
  if (profile.capabilities.length === 0) return 3;
  // Step 4 = NAICS, optional. Skip straight to licenses.
  if (profile.licenses.length === 0) return 5;
  if (profile.certifications.length === 0) return 6;
  if (profile.workAreas.length === 0) return 7;
  if (profile.scopeMinUsd == null && profile.scopeMaxUsd == null && !profile.durationPref) {
    return 8;
  }
  const hasPrime = (profile.primeVsSub?.length ?? 0) > 0;
  const hasGov = (profile.govExperience?.length ?? 0) > 0;
  if (!hasPrime && !hasGov) return 9;
  return 10; // ready to mark complete
}

export async function GET(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const profile = await getFullProfile(auth.userId);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const score = await refreshCompletenessScore(profile);
  const nextStep = computeNextStep(profile);

  return NextResponse.json(
    {
      nextStep,
      onboardedAt: profile.onboardedAt,
      completenessScore: score,
      // Snapshot used by the wizard to pre-fill form state on resume.
      snapshot: {
        companyName: profile.companyName,
        yearFounded: profile.yearFounded,
        employeeBand: profile.employeeBand,
        website: profile.website,
        scopeMinUsd: profile.scopeMinUsd,
        scopeMaxUsd: profile.scopeMaxUsd,
        durationPref: profile.durationPref,
        complexityPref: profile.complexityPref,
        primeVsSub: profile.primeVsSub,
        govExperience: profile.govExperience,
        naicsCodes: profile.naicsCodes,
        specialties: profile.specialties.map((s) => ({ id: s.id, value: s.value, weight: s.weight })),
        capabilities: profile.capabilities.map((c) => ({ id: c.id, value: c.value })),
        licenses: profile.licenses.map((l) => ({
          id: l.id,
          licenseClass: l.licenseClass,
          licenseNumber: l.licenseNumber,
          expiresOn: l.expiresOn,
        })),
        certifications: profile.certifications.map((c) => ({
          id: c.id,
          canonicalId: c.canonicalId,
          displayName: c.displayName,
          kind: c.kind,
        })),
        workAreas: profile.workAreas.map((w) => ({
          id: w.id,
          kind: w.kind,
          name: w.name,
          isHard: w.isHard,
          radiusMiles: w.radiusMiles ?? null,
        })),
        agencyRelationships: profile.agencyRelationships.map((a) => ({
          id: a.id,
          agencyCanonical: a.agencyCanonical,
          agencyDisplay: a.agencyDisplay,
          role: a.role,
          strength: a.strength,
        })),
        dailyRoundupEnabled: profile.dailyRoundupEnabled,
        dailyRoundupTimezone: profile.dailyRoundupTimezone,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// Step 9 calls this to flip onboarded_at. Idempotent.
export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const [row] = await db
    .update(profiles)
    .set({ onboardedAt: new Date(), updatedAt: new Date() })
    .where(eq(profiles.userId, auth.userId))
    .returning();

  if (!row) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  void recordEvent(auth.username, "onboarding_completed");

  // Kick off embedding of the user's specialties + capabilities so the v2
  // matcher can score them. Spec § 5 calls for this to be a background job;
  // until we wire up a queue we run it inline but absorb any failures
  // (missing VOYAGE_API_KEY in dev, transient network issue) without
  // blocking the user from reaching the dashboard.
  try {
    await refreshProfileEmbeddings(auth.userId);
  } catch (err) {
    if (err instanceof EmbeddingConfigError) {
      console.warn("[onboarding] Skipping embeddings — VOYAGE_API_KEY not set");
    } else {
      console.error("[onboarding] Embedding refresh failed:", err);
    }
  }

  return NextResponse.json({ onboardedAt: row.onboardedAt });
}
