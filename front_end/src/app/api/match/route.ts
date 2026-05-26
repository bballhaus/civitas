// GET /api/match/ — return the user's pre-scored matches (Architecture-v2 § 11).
//
// As of the background-rescore PR this route is a cache reader, not a live
// scorer. Match results are computed out-of-band by lib/match-rescore.ts
// when (a) a profile mutation fires, (b) the scrape sync upserts new RFPs,
// or (c) the manual rebuild cron runs. We just hydrate cached rows here.
//
// Fallback: if a user has zero cached rows yet (brand-new account, fresh
// signup before the first rescore landed), we score inline for this one
// request AND schedule a background populate so subsequent loads are fast.
// Same matchV2() is used in both paths — cached results are byte-identical
// to live results for the same (profile, RFP) pair (matchV2 is pure).

import { NextResponse, after } from "next/server";
import { and, asc, desc, eq, gte, isNotNull } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { matchState, profiles, rfpCache } from "@/db/schema";
import { getFullProfile } from "@/db/queries/profile";
import { matchV2, type MatchResult } from "@/lib/matching-v2";
import { rescoreUserMatches } from "@/lib/match-rescore";
import { visibleRfpSourceClause } from "@/lib/rfp-source-visibility";

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

  const [profileRow] = await db
    .select({
      completenessScore: profiles.completenessScore,
      matchScoresPendingSince: profiles.matchScoresPendingSince,
    })
    .from(profiles)
    .where(eq(profiles.userId, auth.userId))
    .limit(1);
  if (!profileRow) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const now = new Date();

  // Cached read path: join match_state to rfp_cache, only rows that have
  // been scored (matchData NOT NULL), and whose deadline is still future.
  const cachedRows = await db
    .select({
      rfpId: rfpCache.id,
      title: rfpCache.title,
      agency: rfpCache.agency,
      location: rfpCache.location,
      deadline: rfpCache.deadline,
      sourceId: rfpCache.sourceId,
      estimatedValueUsd: rfpCache.estimatedValueUsd,
      capabilities: rfpCache.capabilities,
      naicsCodes: rfpCache.naicsCodes,
      cachedScore: matchState.cachedScore,
      matchData: matchState.matchData,
    })
    .from(matchState)
    .innerJoin(rfpCache, eq(matchState.rfpId, rfpCache.id))
    .where(
      and(
        eq(matchState.userId, auth.userId),
        isNotNull(matchState.matchData),
        gte(rfpCache.deadline, now),
        visibleRfpSourceClause(),
      ),
    )
    .orderBy(desc(matchState.cachedScore), asc(rfpCache.deadline))
    .limit(limit);

  let matches: ReturnType<typeof shapeRow>[] = cachedRows.map((r) =>
    shapeRow(r, r.matchData as MatchResult),
  );

  // Fallback for first-time users: nothing cached yet. Score this request
  // live and kick off the background populate so the next load is fast.
  // This preserves the old behavior exactly (same matchV2, same shape).
  if (matches.length === 0) {
    const profile = await getFullProfile(auth.userId);
    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    }
    const rfps = await db
      .select()
      .from(rfpCache)
      .where(and(gte(rfpCache.deadline, now), visibleRfpSourceClause()))
      .orderBy(asc(rfpCache.deadline))
      .limit(limit);
    matches = rfps.map((rfp) => {
      const m = matchV2(profile, rfp);
      return shapeRow(
        {
          rfpId: rfp.id,
          title: rfp.title,
          agency: rfp.agency,
          location: rfp.location,
          deadline: rfp.deadline,
          sourceId: rfp.sourceId,
          estimatedValueUsd: rfp.estimatedValueUsd,
          capabilities: rfp.capabilities,
          naicsCodes: rfp.naicsCodes,
          cachedScore: m.score,
        },
        m,
      );
    });
    matches.sort(byScoreThenDeadline);

    // Schedule a background populate so subsequent loads hit the cache.
    // We also mark the flag so the banner appears until it finishes.
    await db
      .update(profiles)
      .set({ matchScoresPendingSince: new Date() })
      .where(eq(profiles.userId, auth.userId));
    after(async () => {
      await rescoreUserMatches(auth.userId);
    });
  }

  return NextResponse.json(
    {
      count: matches.length,
      profileCompleteness: profileRow.completenessScore,
      // Surfaced for the /matches "Updating your matches…" banner. The page
      // polls /api/match until this becomes null (rescore complete).
      matchScoresPendingSince:
        profileRow.matchScoresPendingSince?.toISOString() ?? null,
      matches,
    },
    { headers: { "Cache-Control": "private, max-age=30" } },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CachedShapeInput {
  rfpId: string;
  title: string;
  agency: string | null;
  location: string | null;
  deadline: Date | null;
  sourceId: string;
  estimatedValueUsd: number | null;
  capabilities: string[] | null;
  naicsCodes: string[] | null;
  cachedScore: number | null;
}

function shapeRow(r: CachedShapeInput, m: MatchResult) {
  return {
    rfpId: r.rfpId,
    title: r.title,
    agency: r.agency,
    location: r.location,
    deadline: r.deadline,
    sourceId: r.sourceId,
    estimatedValueUsd: r.estimatedValueUsd,
    capabilities: r.capabilities ?? [],
    naicsCodes: r.naicsCodes ?? [],
    score: m.score,
    winProbability: m.winProbability,
    tier: m.tier,
    primeEligible: m.primeEligible,
    subEligible: m.subEligible,
    incumbentState: m.incumbent.state,
    incumbentVendor: m.incumbent.namedVendor ?? null,
    dataQuality: m.dataQuality,
    // Same trim as the pre-cache route: list view gets at most 3 reasons.
    topReasons: m.breakdown
      .filter((b) => b.status === "strong" || b.status === "partial")
      .slice(0, 3)
      .map((b) => ({ category: b.category, status: b.status, detail: b.detail })),
  };
}

function byScoreThenDeadline(a: { score: number; deadline: Date | null }, b: { score: number; deadline: Date | null }) {
  if (b.score !== a.score) return b.score - a.score;
  if (!a.deadline || !b.deadline) return 0;
  return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
}
