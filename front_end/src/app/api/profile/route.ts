// Profile read + top-level field updates — Postgres-backed
// (Architecture-v2 § 11). Child collections (specialties, capabilities,
// licenses, certifications, work_areas, agency_relationships) have their
// own routes under /api/profile/<collection>/.
//
// PATCH /api/profile/ updates only the top-level columns on the profiles
// row (company_name, scope_min_usd, duration_pref, etc.). Pass null to
// clear a field; omit a field to leave it unchanged.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getFullProfile,
  updateProfileFields,
  refreshCompletenessScore,
} from "@/db/queries/profile";
import { recordEvent } from "@/lib/event-log";

// Whitelist of profile fields the client is allowed to PATCH directly.
// Anything else (createdAt, vendorFingerprint, etc.) is set server-side.
const PATCHABLE_FIELDS = [
  "companyName",
  "yearFounded",
  "employeeBand",
  "website",
  "scopeMinUsd",
  "scopeMaxUsd",
  "durationPref",
  "complexityPref",
  "primeVsSub",
  "govExperience",
  "dailyRoundupEnabled",
  "dailyRoundupTimezone",
] as const;

type PatchableField = (typeof PATCHABLE_FIELDS)[number];
const PATCHABLE_SET = new Set<string>(PATCHABLE_FIELDS);

export async function GET(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const profile = await getFullProfile(auth.userId);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  // Lazily refresh completeness on every read. Cheap when stable
  // (refreshCompletenessScore short-circuits if the value hasn't changed).
  const score = await refreshCompletenessScore(profile);

  return NextResponse.json(
    { ...profile, completenessScore: score },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;

    // Only let through fields on the whitelist. Drop everything else silently
    // — clients should not be able to set vendorFingerprint, completenessScore,
    // userId, etc. via this endpoint.
    const patch: Partial<Record<PatchableField, unknown>> = {};
    for (const key of Object.keys(body)) {
      if (PATCHABLE_SET.has(key)) {
        patch[key as PatchableField] = body[key];
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "No patchable fields provided" },
        { status: 400 },
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await updateProfileFields(auth.userId, patch as any);
    void recordEvent(auth.username, "profile_updated");
    return NextResponse.json(updated);
  } catch (err) {
    console.error("Profile PATCH error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
