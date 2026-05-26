// Trigger glue for the background rescore pipeline.
//
// Profile-write endpoints call triggerProfileChangedRescore(userId) after a
// successful mutation. We set profiles.match_scores_pending_since=NOW() so
// the /matches stale banner fires immediately, and schedule the rescore
// itself via Next's after() so the API response stays fast.

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
  after(async () => {
    await rescoreUserMatches(userId);
  });
}
