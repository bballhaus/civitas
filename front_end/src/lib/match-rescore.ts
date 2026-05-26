// Background match-scoring writer.
//
// Replaces the live-scoring path of /api/match/ — we now compute matchV2()
// out-of-band and persist the result to match_state. Triggers:
//   - Profile mutation        → rescoreUserMatches(userId)
//   - New RFPs from scraping  → rescoreRfpsForAllUsers(rfpIds)
//   - Manual / cron rebuild   → /api/cron/rebuild-match-state
//
// Invariants the upsert relies on — DO NOT regress:
//   1. Saved/feedback state is sacred. The upsert writes ONLY the cached_*
//      columns + match_data + scored_at. `status`, `feedback_*`, `viewed_at`,
//      `status_changed_at`, and `created_at` are preserved on existing rows
//      and left null on inserts (RFP not yet in tracker).
//   2. matchScore/matchTier/winProbability (the *non*-cached, *non*-prefixed
//      legacy columns) are feedback snapshots — frozen at the moment a user
//      rated good/bad. We never touch them here.
//   3. matchV2() is pure → cached results are byte-identical to live results
//      for the same (profile, rfp) pair. Verified in /api/match's fallback
//      path (live score returned if no cached row yet).

import { and, eq, inArray, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  matchState,
  profiles,
  rfpCache,
  users,
  type RfpCacheRow,
} from "@/db/schema";
import { getFullProfile, type FullProfile } from "@/db/queries/profile";
import { matchV2, type MatchResult } from "@/lib/matching-v2";
import { visibleRfpSourceClause } from "@/lib/rfp-source-visibility";

// Upsert match_state rows in chunks. Postgres has a parameter cap of 65535
// per statement and the values clause uses ~7 params per row; 500 keeps us
// well clear and still saturates a single round-trip.
const UPSERT_CHUNK = 500;

interface RescoreSummary {
  userId: string;
  rfpsScored: number;
  durationMs: number;
}

/**
 * Score every visible future-deadline RFP against this user's profile and
 * upsert the result into match_state. Clears profiles.matchScoresPendingSince
 * at the end so the stale banner in /matches goes away.
 *
 * Safe to call from `after()` — failures are logged, not thrown, because
 * background-failed scoring should never break the foreground response.
 */
export async function rescoreUserMatches(userId: string): Promise<RescoreSummary | null> {
  const t0 = Date.now();
  try {
    const profile = await getFullProfile(userId);
    if (!profile) {
      console.warn(`[match-rescore] no profile for user ${userId}; skipping`);
      return null;
    }

    const now = new Date();
    const rfps = await db
      .select()
      .from(rfpCache)
      .where(and(gte(rfpCache.deadline, now), visibleRfpSourceClause()));

    await upsertScoredRows(userId, profile, rfps, now);
    await clearPendingFlag(userId);

    const summary = { userId, rfpsScored: rfps.length, durationMs: Date.now() - t0 };
    console.log(`[match-rescore] user ${userId}: ${summary.rfpsScored} RFPs in ${summary.durationMs}ms`);
    return summary;
  } catch (err) {
    console.error(`[match-rescore] user ${userId} failed:`, err);
    return null;
  }
}

/**
 * Score a given set of RFPs against every user's profile. Called after
 * sync-rfp-cache upserts new/changed RFPs into rfp_cache. Each user's
 * matchScoresPendingSince is NOT touched here — this is a system-driven
 * refresh, not a user-driven one, so we don't show the banner for it.
 */
export async function rescoreRfpsForAllUsers(rfpIds: string[]): Promise<void> {
  if (rfpIds.length === 0) return;
  const t0 = Date.now();
  try {
    const rfps = await db
      .select()
      .from(rfpCache)
      .where(and(inArray(rfpCache.id, rfpIds), visibleRfpSourceClause()));
    if (rfps.length === 0) {
      console.log(`[match-rescore] no visible RFPs in batch of ${rfpIds.length}; skipping`);
      return;
    }

    const userRows = await db.select({ id: users.id }).from(users);
    const now = new Date();
    let totalScored = 0;
    for (const u of userRows) {
      const profile = await getFullProfile(u.id);
      if (!profile) continue;
      // Only score future-deadline RFPs from the batch (sync-rfp-cache may
      // upsert past-deadline rows as part of a backfill; no point caching
      // those — /api/match filters them out anyway).
      const future = rfps.filter((r) => r.deadline && r.deadline >= now);
      if (future.length === 0) continue;
      await upsertScoredRows(u.id, profile, future, now);
      totalScored += future.length;
    }
    console.log(
      `[match-rescore] new-RFP batch: ${rfps.length} RFPs × ${userRows.length} users → ${totalScored} upserts in ${Date.now() - t0}ms`,
    );
  } catch (err) {
    console.error(`[match-rescore] new-RFP batch failed:`, err);
  }
}

/**
 * Convenience for the sync-rfp-cache hook: rescore every user against every
 * RFP whose refreshedAt is >= the given cutoff (typically the start of the
 * sync call). This catches both inserts and updates without needing the
 * populator to return IDs.
 */
export async function rescoreRfpsRefreshedSince(cutoff: Date): Promise<void> {
  const rows = await db
    .select({ id: rfpCache.id })
    .from(rfpCache)
    .where(and(gte(rfpCache.refreshedAt, cutoff), visibleRfpSourceClause()));
  if (rows.length === 0) {
    console.log(`[match-rescore] no RFPs refreshed since ${cutoff.toISOString()}; skipping`);
    return;
  }
  await rescoreRfpsForAllUsers(rows.map((r) => r.id));
}

/**
 * Score every visible future-deadline RFP against every user. Used by the
 * manual rebuild cron for initial backfill and disaster recovery.
 */
export async function rebuildAllMatchState(): Promise<{
  users: number;
  rfps: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const now = new Date();
  const rfps = await db
    .select()
    .from(rfpCache)
    .where(and(gte(rfpCache.deadline, now), visibleRfpSourceClause()));
  const userRows = await db.select({ id: users.id }).from(users);
  for (const u of userRows) {
    const profile = await getFullProfile(u.id);
    if (!profile) continue;
    await upsertScoredRows(u.id, profile, rfps, now);
    await clearPendingFlag(u.id);
  }
  return { users: userRows.length, rfps: rfps.length, durationMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ScoredRow {
  userId: string;
  rfpId: string;
  cachedScore: number;
  cachedTier: string;
  cachedWinProbability: number;
  cachedIncumbentState: string;
  matchData: MatchResult;
  scoredAt: Date;
}

function scoreRows(
  userId: string,
  profile: FullProfile,
  rfps: RfpCacheRow[],
  scoredAt: Date,
): ScoredRow[] {
  return rfps.map((rfp) => {
    const m = matchV2(profile, rfp);
    return {
      userId,
      rfpId: rfp.id,
      cachedScore: m.score,
      cachedTier: m.tier,
      cachedWinProbability: m.winProbability,
      cachedIncumbentState: m.incumbent.state,
      matchData: m,
      scoredAt,
    };
  });
}

/**
 * Upsert with explicit column list. On conflict (user_id, rfp_id) we ONLY
 * touch the cache columns — status/feedback/viewedAt/etc. on the existing
 * row are preserved unchanged.
 */
async function upsertScoredRows(
  userId: string,
  profile: FullProfile,
  rfps: RfpCacheRow[],
  scoredAt: Date,
): Promise<void> {
  const rows = scoreRows(userId, profile, rfps, scoredAt);
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const slice = rows.slice(i, i + UPSERT_CHUNK);
    await db
      .insert(matchState)
      .values(slice)
      .onConflictDoUpdate({
        target: [matchState.userId, matchState.rfpId],
        // Explicit set — see invariants at the top of the file.
        set: {
          cachedScore: sqlExcluded("cached_score"),
          cachedTier: sqlExcluded("cached_tier"),
          cachedWinProbability: sqlExcluded("cached_win_probability"),
          cachedIncumbentState: sqlExcluded("cached_incumbent_state"),
          matchData: sqlExcluded("match_data"),
          scoredAt: sqlExcluded("scored_at"),
        },
      });
  }
}

async function clearPendingFlag(userId: string): Promise<void> {
  await db
    .update(profiles)
    .set({ matchScoresPendingSince: null })
    .where(eq(profiles.userId, userId));
}

// Resolves to `EXCLUDED.<col>` so on-conflict picks up the value from the row
// we tried to insert without re-passing it as a parameter.
function sqlExcluded(col: string) {
  return sql.raw(`EXCLUDED."${col}"`);
}
