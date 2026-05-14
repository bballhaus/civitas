// Dashboard-view tracking.
//
// POST returns the previous `lastDashboardViewedAt` timestamp AND updates it
// to "now" in one round trip. The frontend uses the returned previous value
// as the threshold for highlighting newly-scraped RFPs. The update fires on
// every dashboard mount, so next visit's threshold = this visit's start time.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getFullProfile, updateProfileFields } from "@/db/queries/profile";

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const profile = await getFullProfile(user.userId);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const previousIso = profile.lastDashboardViewedAt
    ? profile.lastDashboardViewedAt.toISOString()
    : null;

  await updateProfileFields(user.userId, { lastDashboardViewedAt: new Date() });

  return NextResponse.json(
    { previous: previousIso },
    { headers: { "Cache-Control": "no-store" } },
  );
}
