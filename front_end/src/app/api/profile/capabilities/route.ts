// Add a capability to the current user's profile.
// (Architecture-v2 § 11)

import { NextResponse, after } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { profiles } from "@/db/schema";
import { addCapability } from "@/db/queries/profile";
import { refreshProfileEmbeddings, EmbeddingConfigError } from "@/lib/embeddings";
import { naicsCodeForValue, recomputeProfileNaics } from "@/lib/profile-naics";
import { rescoreUserMatches } from "@/lib/match-rescore";

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const value = (body.value || "").trim();
    const canonicalId = body.canonicalId ?? body.canonical_id ?? null;

    if (!value) {
      return NextResponse.json({ error: "value is required" }, { status: 400 });
    }

    const row = await addCapability({ userId: auth.userId, value, canonicalId });

    // Fast inline path mirrors specialties/route.ts — see that file for the
    // full rationale. When the user picked a NAICS-titled capability from
    // the catalog, union the code into profile.naics_codes and set the
    // rescore pending flag in a single combined UPDATE. Free-text adds
    // skip the union and land their LLM-inferred codes via the after()
    // recompute below.
    const titleCode = naicsCodeForValue(value);
    try {
      if (titleCode) {
        await db
          .update(profiles)
          .set({
            naicsCodes: sql`(
              SELECT ARRAY(
                SELECT DISTINCT unnest(COALESCE(${profiles.naicsCodes}, ARRAY[]::text[]) || ARRAY[${titleCode}]::text[])
              )
            )`,
            matchScoresPendingSince: new Date(),
          })
          .where(eq(profiles.userId, auth.userId));
      } else {
        await db
          .update(profiles)
          .set({ matchScoresPendingSince: new Date() })
          .where(eq(profiles.userId, auth.userId));
      }
    } catch (err) {
      console.error("[capabilities] inline naics/pending update failed:", err);
    }

    // Slow work post-response. Recompute first so LLM-inferred codes for
    // free-text adds get persisted before the rescore reads naics_codes.
    //
    // Rescore is gated on onboardedAt to skip the wasted per-pick work
    // during onboarding (see specialties/route.ts for the full rationale).
    // Finish runs one rescore once the profile is settled.
    after(async () => {
      try {
        await recomputeProfileNaics(auth.userId);
      } catch (err) {
        console.error("[capabilities] naics recompute failed:", err);
      }
      let isOnboarded = true;
      try {
        const [row] = await db
          .select({ onboardedAt: profiles.onboardedAt })
          .from(profiles)
          .where(eq(profiles.userId, auth.userId))
          .limit(1);
        isOnboarded = row?.onboardedAt != null;
      } catch (err) {
        console.error("[capabilities] onboardedAt lookup failed; assuming onboarded:", err);
      }
      try {
        await refreshProfileEmbeddings(auth.userId);
      } catch (err) {
        if (err instanceof EmbeddingConfigError) {
          console.warn("[capabilities] skipping embed — VOYAGE_API_KEY not set");
        } else {
          console.error("[capabilities] embed refresh failed:", err);
        }
      }
      if (isOnboarded) {
        try {
          await rescoreUserMatches(auth.userId);
        } catch (err) {
          console.error("[capabilities] rescore failed:", err);
        }
      }
    });

    return NextResponse.json({ ...row, addedNaicsCodes: [] }, { status: 201 });
  } catch (err) {
    console.error("Add capability error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
