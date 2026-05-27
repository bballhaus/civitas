// Trigger glue for the background rescore pipeline.
//
// Profile-write endpoints call triggerProfileChangedRescore(userId) after a
// successful mutation. We set profiles.match_scores_pending_since=NOW() so
// the /matches stale banner fires immediately, and schedule the rescore
// itself via Next's after() so the API response stays fast.
//
// Onboarding gate: while onboardedAt is null the user is mid-wizard, where
// they typically issue ~10 profile mutations in quick succession (specialties,
// capabilities, licenses, …). Rescoring after each one wastes most of the
// work — only the final state matters, and the matcher does the same job
// each time over the same RFP set. We skip the rescore step until Finish
// (POST /api/onboarding/state) triggers a single bundled rescore. The
// pending flag is still set inline by every mutation, so /matches still
// shows the "updating" banner if a mid-onboarding user navigates over.

import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { profiles } from "@/db/schema";
import { rescoreUserMatches } from "@/lib/match-rescore";

export async function triggerProfileChangedRescore(userId: string): Promise<void> {
  // Set the pending flag inline (before the response goes out) so the next
  // GET /api/match sees it even if the user hits refresh immediately.
  try {
    await db
      .update(profiles)
      .set({ matchScoresPendingSince: new Date() })
      .where(eq(profiles.userId, userId));
  } catch (err) {
    // Don't block the profile write on this — the rescore will still run.
    console.error("[match-rescore-trigger] failed to set pending flag:", err);
  }

  // after() runs post-response on the same Lambda. rescoreUserMatches
  // catches its own errors and clears the pending flag on success.
  // The onboardedAt lookup runs inside after() so this helper still
  // returns immediately to the foreground request.
  after(async () => {
    let isOnboarded = true;
    try {
      const [row] = await db
        .select({ onboardedAt: profiles.onboardedAt })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);
      isOnboarded = row?.onboardedAt != null;
    } catch (err) {
      // If we can't tell, default to running the rescore — better to do
      // extra work than to silently drop a needed rescore for an
      // onboarded user.
      console.error("[match-rescore-trigger] onboardedAt lookup failed; running rescore anyway:", err);
    }
    if (!isOnboarded) return;
    await rescoreUserMatches(userId);
  });
}
