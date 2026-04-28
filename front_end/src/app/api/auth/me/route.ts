// Current user info — Postgres-backed (Architecture-v2 § 11).
//
// `?include_profile=1` returns the full profile assembled across all child
// tables (specialties, capabilities, licenses, certifications, work_areas,
// agency_relationships) in addition to the user's basic info.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getFullProfile } from "@/db/queries/profile";

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const includeProfile =
    searchParams.get("include_profile")?.toLowerCase() === "1" ||
    searchParams.get("include_profile")?.toLowerCase() === "true";

  if (includeProfile) {
    const profile = await getFullProfile(user.userId);
    return NextResponse.json(
      {
        userId: user.userId,
        username: user.username,
        profile,
        // RFP status / match feedback move to the match_state table; route
        // to retrieve them lands in a follow-up slice. Stub to empty for now
        // so the dashboard's expected shape is preserved.
        applied_rfp_ids: [],
        in_progress_rfp_ids: [],
        match_feedback_by_rfp: {},
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      userId: user.userId,
      username: user.username,
      profile: null,
      applied_rfp_ids: [],
      in_progress_rfp_ids: [],
      match_feedback_by_rfp: {},
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
