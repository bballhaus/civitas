// GET /api/match/ — score every RFP in rfp_cache against the current user's
// profile and return a sorted list (Architecture-v2 § 11).
//
// Implementation notes:
//   - Pulls the FullProfile in one round trip (six parallel reads, see
//     db/queries/profile.ts).
//   - Pulls rfp_cache rows with a configurable LIMIT + ORDER BY deadline so
//     the first page of the dashboard always shows the most urgent open
//     events. Filtering/paging beyond this is the caller's job for now.
//   - The matcher itself is pure-CPU and stateless; we run all RFPs in a
//     map() with no batching. With a typical catalog size (~1000 events,
//     30 specialty/capability rows per profile) this comfortably fits a
//     serverless request budget. If volumes grow we can promote this to a
//     job that persists scored results into match_state.

import { NextResponse } from "next/server";
import { asc, gte } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { rfpCache } from "@/db/schema";
import { getFullProfile } from "@/db/queries/profile";
import { matchV2 } from "@/lib/matching-v2";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;

export async function GET(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT),
  );

  const profile = await getFullProfile(auth.userId);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  // Only score RFPs whose deadline is still in the future. The matcher
  // doesn't know about staleness; we filter at the SQL boundary.
  const now = new Date();
  const rows = await db
    .select()
    .from(rfpCache)
    .where(gte(rfpCache.deadline, now))
    .orderBy(asc(rfpCache.deadline))
    .limit(limit);

  // matchV2 is synchronous and fast; map() in-place is fine.
  const matches = rows.map((rfp) => {
    const m = matchV2(profile, rfp);
    return {
      rfpId: rfp.id,
      title: rfp.title,
      agency: rfp.agency,
      location: rfp.location,
      deadline: rfp.deadline,
      sourceId: rfp.sourceId,
      estimatedValueUsd: rfp.estimatedValueUsd,
      // Exposed for dashboard filters (capabilities, NAICS multi-select, keyword search).
      capabilities: rfp.capabilities ?? [],
      naicsCodes: rfp.naicsCodes ?? [],
      score: m.score,
      winProbability: m.winProbability,
      tier: m.tier,
      primeEligible: m.primeEligible,
      subEligible: m.subEligible,
      incumbentState: m.incumbent.state,
      incumbentVendor: m.incumbent.namedVendor ?? null,
      dataQuality: m.dataQuality,
      // Trim the breakdown for the list view — the detail endpoint returns
      // the full one. Keeps the dashboard payload light.
      topReasons: m.breakdown
        .filter((b) => b.status === "strong" || b.status === "partial")
        .slice(0, 3)
        .map((b) => ({ category: b.category, status: b.status, detail: b.detail })),
    };
  });

  // Sort by score desc, then by deadline asc so ties land sensibly.
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (!a.deadline || !b.deadline) return 0;
    return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
  });

  return NextResponse.json(
    {
      count: matches.length,
      profileCompleteness: profile.completenessScore,
      matches,
    },
    { headers: { "Cache-Control": "private, max-age=30" } },
  );
}
