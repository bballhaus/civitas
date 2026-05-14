// GET /api/match/{rfpId}/ — single match with full breakdown + citations
// + data_quality + sub track (Architecture-v2 § 11).
//
// The detail panel calls this. Heavier payload than the list view —
// includes every CategoryBreakdown row, the sub-track parallel scoring,
// and the incumbent state machine output so the UI can render the chips
// and the explanation copy.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { rfpCache } from "@/db/schema";
import { getFullProfile } from "@/db/queries/profile";
import { matchV2 } from "@/lib/matching-v2";

export async function GET(
  request: Request,
  context: { params: Promise<{ rfpId: string }> },
) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { rfpId } = await context.params;
  const [profile, rfpRow] = await Promise.all([
    getFullProfile(auth.userId),
    db.select().from(rfpCache).where(eq(rfpCache.id, rfpId)).limit(1),
  ]);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }
  if (rfpRow.length === 0) {
    return NextResponse.json({ error: "RFP not found" }, { status: 404 });
  }

  const rfp = rfpRow[0];
  const m = matchV2(profile, rfp);

  return NextResponse.json(
    {
      rfp: {
        id: rfp.id,
        title: rfp.title,
        description: rfp.description,
        agency: rfp.agency,
        location: rfp.location,
        deadline: rfp.deadline,
        sourceId: rfp.sourceId,
        estimatedValueUsd: rfp.estimatedValueUsd,
      },
      score: m.score,
      winProbability: m.winProbability,
      tier: m.tier,
      primeEligible: m.primeEligible,
      subEligible: m.subEligible,
      gateFailures: m.gateFailures,
      incumbent: m.incumbent,
      dataQuality: m.dataQuality,
      breakdown: m.breakdown,
      subTrack: m.subTrack,
    },
    { headers: { "Cache-Control": "private, max-age=30" } },
  );
}
