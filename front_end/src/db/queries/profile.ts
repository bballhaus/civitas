// Profile data-access layer.
//
// One assembled "full profile" view (used by /api/profile/ GET, the dashboard,
// and the matcher) plus mutation helpers for each child table.
//
// Mutations aim to be small + obvious; complex logic (e.g. claim acceptance,
// vendor-fingerprint resolution) lives in higher-level handlers, not here.

import { and, eq } from "drizzle-orm";
import { db } from "../client";
import {
  profiles,
  specialties,
  capabilities,
  licenses,
  certifications,
  workAreas,
  agencyRelationships,
  type Profile,
  type Specialty,
  type Capability,
  type License,
  type Certification,
  type WorkArea,
  type AgencyRelationship,
} from "../schema";

// ---------------------------------------------------------------------------
// Full profile (joins all child tables)
// ---------------------------------------------------------------------------

export interface FullProfile extends Profile {
  specialties: Specialty[];
  capabilities: Capability[];
  licenses: License[];
  certifications: Certification[];
  workAreas: WorkArea[];
  agencyRelationships: AgencyRelationship[];
}

/**
 * Read everything that hangs off a user's profile.
 *
 * Six small queries in parallel, not one big join — Drizzle doesn't have
 * great ergonomics for many-to-one fan-out, and parallel small queries
 * actually outperform a giant LEFT JOIN once a profile has tens of rows
 * across the child tables (no row multiplication).
 */
export async function getFullProfile(userId: string): Promise<FullProfile | null> {
  const [profileRow, specialtyRows, capabilityRows, licenseRows, certRows, workAreaRows, agencyRows] =
    await Promise.all([
      db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1),
      db.select().from(specialties).where(eq(specialties.userId, userId)),
      db.select().from(capabilities).where(eq(capabilities.userId, userId)),
      db.select().from(licenses).where(eq(licenses.userId, userId)),
      db.select().from(certifications).where(eq(certifications.userId, userId)),
      db.select().from(workAreas).where(eq(workAreas.userId, userId)),
      db.select().from(agencyRelationships).where(eq(agencyRelationships.userId, userId)),
    ]);

  if (profileRow.length === 0) return null;

  return {
    ...profileRow[0],
    specialties: specialtyRows,
    capabilities: capabilityRows,
    licenses: licenseRows,
    certifications: certRows,
    workAreas: workAreaRows,
    agencyRelationships: agencyRows,
  };
}

// ---------------------------------------------------------------------------
// Profile-level field updates
// ---------------------------------------------------------------------------

/**
 * Patch top-level profile fields (company_name, scope_min_usd, etc.).
 * Child collections (specialties, etc.) have their own helpers below.
 */
export async function updateProfileFields(
  userId: string,
  patch: Partial<Omit<Profile, "userId" | "createdAt" | "updatedAt">>,
): Promise<Profile> {
  const [updated] = await db
    .update(profiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(profiles.userId, userId))
    .returning();
  return updated;
}

// ---------------------------------------------------------------------------
// Specialties
// ---------------------------------------------------------------------------

export interface AddSpecialtyInput {
  userId: string;
  value: string;
  weight?: "primary" | "secondary";
  canonicalId?: string | null;
}

export async function addSpecialty(input: AddSpecialtyInput): Promise<Specialty> {
  const [row] = await db
    .insert(specialties)
    .values({
      userId: input.userId,
      value: input.value,
      weight: input.weight ?? "primary",
      canonicalId: input.canonicalId ?? null,
    })
    .onConflictDoNothing({ target: [specialties.userId, specialties.value] })
    .returning();

  if (row) return row;

  // Conflict: row already existed. Read it back so callers always get a result.
  const [existing] = await db
    .select()
    .from(specialties)
    .where(and(eq(specialties.userId, input.userId), eq(specialties.value, input.value)))
    .limit(1);
  return existing;
}

export async function removeSpecialty(userId: string, specialtyId: string): Promise<boolean> {
  const result = await db
    .delete(specialties)
    .where(and(eq(specialties.id, specialtyId), eq(specialties.userId, userId)))
    .returning({ id: specialties.id });
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Capabilities (broader than specialties)
// ---------------------------------------------------------------------------

export interface AddCapabilityInput {
  userId: string;
  value: string;
  canonicalId?: string | null;
}

export async function addCapability(input: AddCapabilityInput): Promise<Capability> {
  const [row] = await db
    .insert(capabilities)
    .values({
      userId: input.userId,
      value: input.value,
      canonicalId: input.canonicalId ?? null,
    })
    .onConflictDoNothing({ target: [capabilities.userId, capabilities.value] })
    .returning();

  if (row) return row;

  const [existing] = await db
    .select()
    .from(capabilities)
    .where(and(eq(capabilities.userId, input.userId), eq(capabilities.value, input.value)))
    .limit(1);
  return existing;
}

export async function removeCapability(userId: string, capabilityId: string): Promise<boolean> {
  const result = await db
    .delete(capabilities)
    .where(and(eq(capabilities.id, capabilityId), eq(capabilities.userId, userId)))
    .returning({ id: capabilities.id });
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Licenses (typed by class — A, B, C-12, PE, DIR, ...)
// ---------------------------------------------------------------------------

export interface AddLicenseInput {
  userId: string;
  licenseClass: string;
  licenseNumber?: string;
  expiresOn?: string; // ISO date
  verified?: boolean;
}

export async function addLicense(input: AddLicenseInput): Promise<License> {
  const [row] = await db
    .insert(licenses)
    .values({
      userId: input.userId,
      licenseClass: input.licenseClass,
      licenseNumber: input.licenseNumber,
      expiresOn: input.expiresOn,
      verified: input.verified ?? false,
    })
    .returning();
  return row;
}

export async function removeLicense(userId: string, licenseId: string): Promise<boolean> {
  const result = await db
    .delete(licenses)
    .where(and(eq(licenses.id, licenseId), eq(licenses.userId, userId)))
    .returning({ id: licenses.id });
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Certifications (hard vs soft)
// ---------------------------------------------------------------------------

export interface AddCertificationInput {
  userId: string;
  canonicalId: string;
  displayName: string;
  kind: "hard" | "soft";
  expiresOn?: string;
}

export async function addCertification(
  input: AddCertificationInput,
): Promise<Certification> {
  const [row] = await db
    .insert(certifications)
    .values({
      userId: input.userId,
      canonicalId: input.canonicalId,
      displayName: input.displayName,
      kind: input.kind,
      expiresOn: input.expiresOn,
    })
    .onConflictDoUpdate({
      target: [certifications.userId, certifications.canonicalId],
      // Allow upgrading display_name / kind / expires_on if same canonical_id
      // is added again.
      set: {
        displayName: input.displayName,
        kind: input.kind,
        expiresOn: input.expiresOn,
      },
    })
    .returning();
  return row;
}

export async function removeCertification(
  userId: string,
  certificationId: string,
): Promise<boolean> {
  const result = await db
    .delete(certifications)
    .where(
      and(eq(certifications.id, certificationId), eq(certifications.userId, userId)),
    )
    .returning({ id: certifications.id });
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Work areas (with hard flag)
// ---------------------------------------------------------------------------

export interface AddWorkAreaInput {
  userId: string;
  kind: "city" | "county" | "metro" | "state";
  name: string;
  isHard?: boolean;
}

export async function addWorkArea(input: AddWorkAreaInput): Promise<WorkArea> {
  const [row] = await db
    .insert(workAreas)
    .values({
      userId: input.userId,
      kind: input.kind,
      name: input.name,
      isHard: input.isHard ?? false,
    })
    .onConflictDoUpdate({
      target: [workAreas.userId, workAreas.kind, workAreas.name],
      set: { isHard: input.isHard ?? false },
    })
    .returning();
  return row;
}

export async function removeWorkArea(userId: string, workAreaId: string): Promise<boolean> {
  const result = await db
    .delete(workAreas)
    .where(and(eq(workAreas.id, workAreaId), eq(workAreas.userId, userId)))
    .returning({ id: workAreas.id });
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Agency relationships
// ---------------------------------------------------------------------------

export interface AddAgencyRelationshipInput {
  userId: string;
  agencyCanonical: string;
  agencyDisplay: string;
  role: "prime" | "sub";
  contractCount?: number;
  lastContractAt?: string;
  strength?: number; // 1-5
  source?: "user" | "vendor_fingerprint" | "extraction";
}

export async function addAgencyRelationship(
  input: AddAgencyRelationshipInput,
): Promise<AgencyRelationship> {
  const [row] = await db
    .insert(agencyRelationships)
    .values({
      userId: input.userId,
      agencyCanonical: input.agencyCanonical,
      agencyDisplay: input.agencyDisplay,
      role: input.role,
      contractCount: input.contractCount ?? 1,
      lastContractAt: input.lastContractAt,
      strength: input.strength ?? 1,
      source: input.source ?? "user",
    })
    .onConflictDoUpdate({
      target: [
        agencyRelationships.userId,
        agencyRelationships.agencyCanonical,
        agencyRelationships.role,
      ],
      // Same (user, agency, role) re-asserted: bump count + update recency.
      // Keep the higher strength; don't downgrade a 5 to a 1 because of a
      // later weak signal.
      set: {
        contractCount: input.contractCount ?? 1,
        lastContractAt: input.lastContractAt,
        agencyDisplay: input.agencyDisplay,
      },
    })
    .returning();
  return row;
}

export async function removeAgencyRelationship(
  userId: string,
  agencyRelationshipId: string,
): Promise<boolean> {
  const result = await db
    .delete(agencyRelationships)
    .where(
      and(
        eq(agencyRelationships.id, agencyRelationshipId),
        eq(agencyRelationships.userId, userId),
      ),
    )
    .returning({ id: agencyRelationships.id });
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Completeness score
// ---------------------------------------------------------------------------

/**
 * % of weighted profile fields populated. Drives the "X% complete" gauge
 * on the profile page and signals to the matcher when a profile is too thin
 * to score reliably.
 *
 * Weights match the matching algorithm — fields the matcher cares most about
 * count more toward completeness.
 */
const COMPLETENESS_WEIGHTS = {
  companyName: 5,
  specialties: 25, // single biggest signal in the matcher
  capabilities: 15,
  licenses: 10,
  certifications: 10,
  workAreas: 10,
  agencyRelationships: 10,
  scopeRange: 5, // both min and max set
  durationPref: 3,
  complexityPref: 3,
  primeVsSub: 2,
  govExperience: 2,
} as const;

const TOTAL_WEIGHT = Object.values(COMPLETENESS_WEIGHTS).reduce((a, b) => a + b, 0);

export function computeCompletenessScore(profile: FullProfile): number {
  let earned = 0;

  if (profile.companyName?.trim()) earned += COMPLETENESS_WEIGHTS.companyName;
  if (profile.specialties.length > 0) earned += COMPLETENESS_WEIGHTS.specialties;
  if (profile.capabilities.length > 0) earned += COMPLETENESS_WEIGHTS.capabilities;
  if (profile.licenses.length > 0) earned += COMPLETENESS_WEIGHTS.licenses;
  if (profile.certifications.length > 0) earned += COMPLETENESS_WEIGHTS.certifications;
  if (profile.workAreas.length > 0) earned += COMPLETENESS_WEIGHTS.workAreas;
  if (profile.agencyRelationships.length > 0) earned += COMPLETENESS_WEIGHTS.agencyRelationships;
  if (profile.scopeMinUsd != null && profile.scopeMaxUsd != null) earned += COMPLETENESS_WEIGHTS.scopeRange;
  if (profile.durationPref) earned += COMPLETENESS_WEIGHTS.durationPref;
  if (profile.complexityPref) earned += COMPLETENESS_WEIGHTS.complexityPref;
  if (profile.primeVsSub) earned += COMPLETENESS_WEIGHTS.primeVsSub;
  if (profile.govExperience) earned += COMPLETENESS_WEIGHTS.govExperience;

  return Math.round((earned / TOTAL_WEIGHT) * 100);
}

/**
 * Recompute and persist `completeness_score` on the profile row.
 * Called after any mutation. Cheap (no extra reads — caller passes the profile).
 */
export async function refreshCompletenessScore(profile: FullProfile): Promise<number> {
  const score = computeCompletenessScore(profile);
  if (Math.round((profile.completenessScore ?? 0) * 100) / 100 === score) {
    return score; // no change; skip the write
  }
  await db
    .update(profiles)
    .set({ completenessScore: score, updatedAt: new Date() })
    .where(eq(profiles.userId, profile.userId));
  return score;
}
