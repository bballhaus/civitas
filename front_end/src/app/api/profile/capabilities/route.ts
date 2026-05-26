// Add a capability to the current user's profile.
// (Architecture-v2 § 11)

import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { profiles } from "@/db/schema";
import { addCapability } from "@/db/queries/profile";
import { refreshProfileEmbeddings, EmbeddingConfigError } from "@/lib/embeddings";
import { recomputeProfileNaics } from "@/lib/profile-naics";
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

    // Derive profile.naics_codes from NAICS-titled capabilities. Server-side
    // mirror of the specialties path — covers every write path, not just
    // the onboarding picker. Stays inline (not deferred to after()) so the
    // onboarding wizard's GET /api/onboarding/state on Continue returns
    // fresh codes for Step 4. The `added` list bubbles back in the
    // response for any callers that still consume it; the onboarding UI
    // no longer renders the inferred-NAICS banner so this is effectively
    // just a contract leftover.
    let addedNaicsCodes: string[] = [];
    try {
      const result = await recomputeProfileNaics(auth.userId);
      addedNaicsCodes = result.added;
    } catch (err) {
      console.error("[capabilities] naics recompute failed:", err);
    }

    // Set the rescore pending flag inline so /matches's stale banner fires
    // immediately on the user's next GET, even before the post-response
    // rescore has finished. Same effect as triggerProfileChangedRescore
    // used to give us, just hoisted out so the slow work can move into
    // after() below.
    try {
      await db
        .update(profiles)
        .set({ matchScoresPendingSince: new Date() })
        .where(eq(profiles.userId, auth.userId));
    } catch (err) {
      console.error("[capabilities] failed to set rescore pending flag:", err);
    }

    // Voyage embed (~500ms per pick) + RFP rescore (sweeps the cache) used
    // to block the response, making the onboarding Continue button wait
    // for the slowest in-flight POST when the optimistic handler drained
    // pending. Move both into after() so the row insert alone determines
    // the POST latency (~50ms). Sequenced — rescore reads the freshly
    // written embeddings, so embed must finish first. Both are fail-soft.
    after(async () => {
      try {
        await refreshProfileEmbeddings(auth.userId);
      } catch (err) {
        if (err instanceof EmbeddingConfigError) {
          console.warn("[capabilities] skipping embed — VOYAGE_API_KEY not set");
        } else {
          console.error("[capabilities] embed refresh failed:", err);
        }
      }
      try {
        await rescoreUserMatches(auth.userId);
      } catch (err) {
        console.error("[capabilities] rescore failed:", err);
      }
    });

    return NextResponse.json({ ...row, addedNaicsCodes }, { status: 201 });
  } catch (err) {
    console.error("Add capability error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
