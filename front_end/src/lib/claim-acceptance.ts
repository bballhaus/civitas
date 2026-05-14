// Claim acceptance dispatcher (Architecture-v2 § 6.5).
//
// A claim's `field_path` tells us which profile table to write to. We
// resolve the path to the right insert helper (already canonicalized in
// db/queries/profile.ts) so the writes here stay narrow and the field-
// path → table mapping lives in one place.
//
// On accept: write to the profile table + flip claim status.
// On reject: just flip claim status.

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { claims, profiles } from "@/db/schema";
import {
  addSpecialty,
  addCapability,
  addLicense,
  addCertification,
  addWorkArea,
  addAgencyRelationship,
} from "@/db/queries/profile";

export type ClaimDecision = "accepted" | "rejected";

export async function acceptClaim(claimId: string, userId: string): Promise<void> {
  const [row] = await db
    .select()
    .from(claims)
    .where(and(eq(claims.id, claimId), eq(claims.userId, userId)))
    .limit(1);
  if (!row) throw new Error("Claim not found");
  if (row.status !== "pending") return; // idempotent

  await applyClaimToProfile(userId, row.fieldPath, row.value);

  await db
    .update(claims)
    .set({ status: "accepted", decidedAt: new Date() })
    .where(eq(claims.id, claimId));
}

export async function rejectClaim(claimId: string, userId: string): Promise<void> {
  // No profile write — we keep rejected rows around so we can tune the
  // extractor later (spec § 6.5).
  await db
    .update(claims)
    .set({ status: "rejected", decidedAt: new Date() })
    .where(and(eq(claims.id, claimId), eq(claims.userId, userId)));
}

export async function editAndAcceptClaim(
  claimId: string,
  userId: string,
  newValue: string,
): Promise<void> {
  const [row] = await db
    .select()
    .from(claims)
    .where(and(eq(claims.id, claimId), eq(claims.userId, userId)))
    .limit(1);
  if (!row) throw new Error("Claim not found");

  await applyClaimToProfile(userId, row.fieldPath, newValue);
  await db
    .update(claims)
    .set({ value: newValue, status: "accepted", decidedAt: new Date() })
    .where(eq(claims.id, claimId));
}

// ---------------------------------------------------------------------------
// field_path → profile-table mapping
// ---------------------------------------------------------------------------

async function applyClaimToProfile(
  userId: string,
  fieldPath: string,
  value: string,
): Promise<void> {
  switch (fieldPath) {
    case "specialties.value":
      await addSpecialty({ userId, value, weight: "primary" });
      return;
    case "capabilities.value":
      await addCapability({ userId, value });
      return;
    case "licenses.class":
      await addLicense({ userId, licenseClass: value });
      return;
    case "certifications.canonical": {
      // Accept either canonical IDs ("dvbe") or display names that map to
      // a canonical. Conservative fallback: store as-is with kind='soft'
      // so we don't accidentally promote unknown strings to hard gates.
      const canonical = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      await addCertification({
        userId,
        canonicalId: canonical,
        displayName: value,
        kind: "soft",
      });
      return;
    }
    case "work_areas.name":
      await addWorkArea({ userId, kind: "city", name: value });
      return;
    case "agency_relationships.agency":
      await addAgencyRelationship({
        userId,
        agencyCanonical: value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
        agencyDisplay: value,
        role: "prime",
        source: "extraction",
      });
      return;
    case "profile.company_name":
      await db.update(profiles).set({ companyName: value, updatedAt: new Date() })
        .where(eq(profiles.userId, userId));
      return;
    case "profile.year_founded": {
      const yr = parseInt(value, 10);
      if (!Number.isNaN(yr)) {
        await db.update(profiles).set({ yearFounded: yr, updatedAt: new Date() })
          .where(eq(profiles.userId, userId));
      }
      return;
    }
    case "profile.employee_band":
      await db.update(profiles).set({ employeeBand: value, updatedAt: new Date() })
        .where(eq(profiles.userId, userId));
      return;
    case "profile.website":
      await db.update(profiles).set({ website: value, updatedAt: new Date() })
        .where(eq(profiles.userId, userId));
      return;
    default:
      // Unknown field_path — leave the claim accepted-but-not-applied.
      // The extractor occasionally invents field_paths; logging here lets
      // us notice and tighten the prompt rather than silently dropping.
      console.warn(`[claims] accepted claim with unknown field_path: ${fieldPath}`);
  }
}
