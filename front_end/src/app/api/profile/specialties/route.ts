// Add a specialty to the current user's profile.
// (Architecture-v2 § 11)

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { addSpecialty } from "@/db/queries/profile";
import { refreshProfileEmbeddings, EmbeddingConfigError } from "@/lib/embeddings";
import { recomputeProfileNaics } from "@/lib/profile-naics";
import { triggerProfileChangedRescore } from "@/lib/match-rescore-trigger";

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

    // Derive profile.naics_codes from NAICS-titled specialties. Server-side
    // so it covers API-direct adds and /profile-setup edits, not just the
    // onboarding picker. Fail-soft — a stale naics_codes column shouldn't
    // block adding a specialty. The `added` list is bubbled back in the
    // response so the onboarding UI can show the user which codes were
    // just inferred (and let them remove bad LLM picks).
    let addedNaicsCodes: string[] = [];
    try {
      const result = await recomputeProfileNaics(auth.userId);
      addedNaicsCodes = result.added;
    } catch (err) {
      console.error("[specialties] naics recompute failed:", err);
    }

    // Embed the new specialty so the v2 matcher can score it. Same
    // fail-soft pattern as onboarding — a Voyage outage or missing key
    // shouldn't block adding the specialty.
    try {
      await refreshProfileEmbeddings(auth.userId);
    } catch (err) {
      if (err instanceof EmbeddingConfigError) {
        console.warn("[specialties] skipping embed — VOYAGE_API_KEY not set");
      } else {
        console.error("[specialties] embed refresh failed:", err);
      }
    }

    await triggerProfileChangedRescore(auth.userId);
    return NextResponse.json({ ...row, addedNaicsCodes }, { status: 201 });
  } catch (err) {
    console.error("Add specialty error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
