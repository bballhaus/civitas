// Current user info — Postgres-backed (Architecture-v2 § 11).
//
// `?include_profile=1` returns the full profile assembled across all child
// tables (specialties, capabilities, licenses, certifications, work_areas,
// agency_relationships) in addition to the user's basic info.
//
// The pipeline snapshot (saved/in_progress/bid_submitted/won/lost/no_bid
// arrays + match feedback) is read from match_state and always included so
// the home page, dashboard, detail page, and tracker can all hydrate from
// one round-trip.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getFullProfile } from "@/db/queries/profile";
import { getPipelineSnapshot } from "@/db/queries/match-state";

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const includeProfile =
    searchParams.get("include_profile")?.toLowerCase() === "1" ||
    searchParams.get("include_profile")?.toLowerCase() === "true";

  const [profile, snapshot] = await Promise.all([
    includeProfile ? getFullProfile(user.userId) : Promise.resolve(null),
    getPipelineSnapshot(user.userId),
  ]);

  return NextResponse.json(
    {
      userId: user.userId,
      username: user.username,
      profile,
      ...snapshot,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
