// Add a capability to the current user's profile.
// (Architecture-v2 § 11)

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { addCapability } from "@/db/queries/profile";
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
    const canonicalId = body.canonicalId ?? body.canonical_id ?? null;

    if (!value) {
      return NextResponse.json({ error: "value is required" }, { status: 400 });
    }

    const row = await addCapability({ userId: auth.userId, value, canonicalId });

    // Derive profile.naics_codes from NAICS-titled capabilities. Server-side
    // mirror of the specialties path — covers every write path, not just
    // the onboarding picker.
    try {
      await recomputeProfileNaics(auth.userId);
    } catch (err) {
      console.error("[capabilities] naics recompute failed:", err);
    }

    // Embed the new capability so the v2 matcher can score it. Same
    // fail-soft pattern as onboarding.
    try {
      await refreshProfileEmbeddings(auth.userId);
    } catch (err) {
      if (err instanceof EmbeddingConfigError) {
        console.warn("[capabilities] skipping embed — VOYAGE_API_KEY not set");
      } else {
        console.error("[capabilities] embed refresh failed:", err);
      }
    }

    await triggerProfileChangedRescore(auth.userId);
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error("Add capability error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
