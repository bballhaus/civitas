import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getOrCreateProfile } from "@/lib/profile-storage";
import { getRfpStatus, getMatchFeedback } from "@/lib/rfp-status";

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const includeProfile =
    searchParams.get("include_profile")?.toLowerCase() === "1" ||
    searchParams.get("include_profile")?.toLowerCase() === "true";

  if (includeProfile) {
    const profile = await getOrCreateProfile(user.username);
    const rfpStatus = await getRfpStatus(user.username);
    const matchFeedback = await getMatchFeedback(user.username);

    return NextResponse.json({
      username: user.username,
      profile,
      applied_rfp_ids: rfpStatus.applied_rfp_ids,
      in_progress_rfp_ids: rfpStatus.in_progress_rfp_ids,
      match_feedback_by_rfp: matchFeedback,
    });
  }

  return NextResponse.json({
    username: user.username,
    profile: null,
    applied_rfp_ids: [],
    in_progress_rfp_ids: [],
    match_feedback_by_rfp: {},
  });
}
