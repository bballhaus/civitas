// Add a specialty to the current user's profile.
// (Architecture-v2 § 11)

import { NextResponse, after } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { profiles } from "@/db/schema";
import { addSpecialty } from "@/db/queries/profile";
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
    const weight = body.weight;
    const canonicalId = body.canonicalId ?? body.canonical_id ?? null;

    if (!value) {
      return NextResponse.json({ error: "value is required" }, { status: 400 });
    }
    if (weight && weight !== "primary" && weight !== "secondary") {
      return NextResponse.json(
        { error: "weight must be 'primary' or 'secondary'" },
        { status: 400 },
      );
    }

    const row = await addSpecialty({
      userId: auth.userId,
      value,
      weight: weight ?? "primary",
      canonicalId,
    });

    // Fast inline path: when the user picked a NAICS-titled value from the
    // catalog (the common case in onboarding), look up the code in-memory
    // and union it into profile.naics_codes via a single combined UPDATE
    // that also sets the rescore pending flag. Avoids the 3 SELECT + 1
    // UPDATE round-trips that the full recomputeProfileNaics costs on
    // every pick, which was driving the Continue button's drainPending
    // wait into the 500-800ms range steady-state.
    //
    // Free-text values fall through to the after() recompute below — they
    // need LLM inference to map to codes anyway, so the snapshot.naicsCodes
    // landing one Continue-cycle late is acceptable (the user reviews/edits
    // codes on Step 4 either way).
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
      console.error("[specialties] inline naics/pending update failed:", err);
    }

    // Slow work runs post-response on the same Lambda. Order matters:
    //   recompute (may LLM-infer for free-text) → embed → rescore.
    // The recompute is the authoritative reconcile against all of the
    // user's specs/caps — fixes any drift the fast inline path missed
    // (e.g. a free-text value's LLM-inferred codes, or codes that should
    // be dropped because their backing spec was deleted). Fail-soft
    // throughout — a Voyage outage or an Anthropic error shouldn't
    // visibly affect the user's onboarding.
    after(async () => {
      try {
        await recomputeProfileNaics(auth.userId);
      } catch (err) {
        console.error("[specialties] naics recompute failed:", err);
      }
      try {
        await refreshProfileEmbeddings(auth.userId);
      } catch (err) {
        if (err instanceof EmbeddingConfigError) {
          console.warn("[specialties] skipping embed — VOYAGE_API_KEY not set");
        } else {
          console.error("[specialties] embed refresh failed:", err);
        }
      }
      try {
        await rescoreUserMatches(auth.userId);
      } catch (err) {
        console.error("[specialties] rescore failed:", err);
      }
    });

    // addedNaicsCodes is kept on the response for back-compat; no current
    // caller consumes it (the onboarding inferred-NAICS banner that read
    // this field was removed). LLM-inferred codes for free-text adds now
    // land on the profile via the after() recompute, not in this payload.
    return NextResponse.json({ ...row, addedNaicsCodes: [] }, { status: 201 });
  } catch (err) {
    console.error("Add specialty error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
