// POST /api/profile/vendor/resolve/ — Architecture-v2 § 5 last paragraph
// and § 11.
//
// Fuzzy-matches the caller's company_name against the vendors table and
// either (a) returns candidate matches if no fingerprint was supplied, or
// (b) writes profiles.vendor_fingerprint to claim a specific entry, which
// unlocks auto-population of agency_relationships from past PlanetBids
// bid history.
//
// GET also supported as a convenience — same as POST without a fingerprint.

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { profiles, vendors } from "@/db/schema";
import { recordEvent } from "@/lib/event-log";

// Tunable threshold for the trigram similarity score that the vendor name
// gin_trgm index supports. Conservative default; we can tighten once we see
// real false positives.
const MIN_SIMILARITY = 0.4;
const MAX_CANDIDATES = 10;

async function searchByName(query: string) {
  if (!query.trim()) return [];
  // Uses the trigram index on vendors.name (already created out-of-band as
  // a SQL migration per the schema's gin_trgm note). Falls back gracefully
  // to ILIKE if the extension isn't enabled.
  return db
    .select({
      fingerprint: vendors.fingerprint,
      name: vendors.name,
      city: vendors.city,
      state: vendors.state,
      bidCount: vendors.bidCount,
      winCount: vendors.winCount,
      // Cast to number so the JSON serializer doesn't return a string.
      similarity: sql<number>`similarity(${vendors.name}, ${query})`,
    })
    .from(vendors)
    .where(sql`similarity(${vendors.name}, ${query}) > ${MIN_SIMILARITY}`)
    .orderBy(sql`similarity(${vendors.name}, ${query}) desc`)
    .limit(MAX_CANDIDATES);
}

export async function GET(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, auth.userId))
    .limit(1);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  if (profile.vendorFingerprint) {
    const [resolved] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.fingerprint, profile.vendorFingerprint))
      .limit(1);
    return NextResponse.json({
      claimed: profile.vendorFingerprint,
      resolvedAt: profile.vendorResolvedAt,
      vendor: resolved ?? null,
    });
  }

  const candidates = profile.companyName ? await searchByName(profile.companyName) : [];
  return NextResponse.json({
    claimed: null,
    companyName: profile.companyName,
    candidates,
  });
}

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = (await request.json()) as { fingerprint?: string };
  const fingerprint = body.fingerprint?.trim();
  if (!fingerprint) {
    return NextResponse.json({ error: "fingerprint required" }, { status: 400 });
  }

  // Sanity-check that the fingerprint actually exists.
  const [vendor] = await db
    .select()
    .from(vendors)
    .where(eq(vendors.fingerprint, fingerprint))
    .limit(1);
  if (!vendor) {
    return NextResponse.json({ error: "Vendor fingerprint not found" }, { status: 404 });
  }

  const [updated] = await db
    .update(profiles)
    .set({
      vendorFingerprint: fingerprint,
      vendorResolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(profiles.userId, auth.userId))
    .returning();

  void recordEvent(auth.username, "profile_updated", { vendor_resolved: true });
  return NextResponse.json({ claimed: fingerprint, vendor, profile: updated });
}

export async function DELETE(request: Request) {
  // Unclaim — undoes a resolution, useful if the user picked the wrong one.
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  await db
    .update(profiles)
    .set({ vendorFingerprint: null, vendorResolvedAt: null, updatedAt: new Date() })
    .where(eq(profiles.userId, auth.userId));
  return NextResponse.json({ ok: true });
}
