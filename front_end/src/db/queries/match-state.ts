// Match state data-access layer.
//
// Owns the bidding-pipeline status ('saved' | 'in_progress' | 'bid_submitted'
// | 'won' | 'lost' | 'no_bid') and the per-RFP match feedback (good/bad +
// reason). Replaces the S3 user-data fields (applied_rfp_ids,
// in_progress_rfp_ids, match_feedback_by_rfp) used by the old code path.

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../client";
import { matchState, type MatchState } from "../schema";

export type PipelineStatus =
  | "saved"
  | "in_progress"
  | "bid_submitted"
  | "won"
  | "lost"
  | "no_bid";

export const PIPELINE_STATUSES: readonly PipelineStatus[] = [
  "saved",
  "in_progress",
  "bid_submitted",
  "won",
  "lost",
  "no_bid",
] as const;

export function isPipelineStatus(v: unknown): v is PipelineStatus {
  return typeof v === "string" && (PIPELINE_STATUSES as readonly string[]).includes(v);
}

export interface MatchFeedback {
  rating: "good" | "bad";
  reason?: string;
  match_score: number;
  match_tier: string;
  created_at: string;
}

export interface PipelineSnapshot {
  saved_rfp_ids: string[];
  in_progress_rfp_ids: string[];
  bid_submitted_rfp_ids: string[];
  won_rfp_ids: string[];
  lost_rfp_ids: string[];
  no_bid_rfp_ids: string[];
  match_feedback_by_rfp: Record<string, MatchFeedback>;
}

function emptySnapshot(): PipelineSnapshot {
  return {
    saved_rfp_ids: [],
    in_progress_rfp_ids: [],
    bid_submitted_rfp_ids: [],
    won_rfp_ids: [],
    lost_rfp_ids: [],
    no_bid_rfp_ids: [],
    match_feedback_by_rfp: {},
  };
}

function bucketKey(status: PipelineStatus): keyof Omit<PipelineSnapshot, "match_feedback_by_rfp"> {
  return `${status}_rfp_ids` as const;
}

function rowToFeedback(row: MatchState): MatchFeedback | null {
  if (!row.feedbackRating || (row.feedbackRating !== "good" && row.feedbackRating !== "bad")) return null;
  return {
    rating: row.feedbackRating,
    reason: row.feedbackReason ?? undefined,
    match_score: row.matchScore ?? 0,
    match_tier: row.matchTier ?? "",
    created_at: (row.feedbackAt ?? row.createdAt).toISOString(),
  };
}

/**
 * Read every match_state row for a user and bucket it by pipeline status
 * + collect any match feedback. Used to hydrate /api/auth/me.
 */
export async function getPipelineSnapshot(userId: string): Promise<PipelineSnapshot> {
  const rows = await db
    .select()
    .from(matchState)
    .where(eq(matchState.userId, userId));
  const snap = emptySnapshot();
  for (const r of rows) {
    if (isPipelineStatus(r.status)) {
      snap[bucketKey(r.status)].push(r.rfpId);
    }
    const fb = rowToFeedback(r);
    if (fb) snap.match_feedback_by_rfp[r.rfpId] = fb;
  }
  return snap;
}

/**
 * Set (or clear) the pipeline status for a given (user, RFP). Pass `null`
 * to remove the RFP from the tracker entirely. Upserts: if a row already
 * exists for this (user, RFP), it is updated; otherwise inserted.
 *
 * Task seeding is handled by the API route layer, which calls
 * `seedDefaultTasks` (idempotent) on every non-null status set.
 */
export async function setRfpStatus(
  userId: string,
  rfpId: string,
  status: PipelineStatus | null,
): Promise<void> {
  const existing = await db
    .select({ id: matchState.id })
    .from(matchState)
    .where(and(eq(matchState.userId, userId), eq(matchState.rfpId, rfpId)))
    .limit(1);
  const now = new Date();

  if (existing.length === 0) {
    if (status === null) return;
    await db.insert(matchState).values({
      userId,
      rfpId,
      status,
      statusChangedAt: now,
    });
    return;
  }

  await db
    .update(matchState)
    .set({ status, statusChangedAt: now })
    .where(eq(matchState.id, existing[0].id));
}

/**
 * Write match feedback (good/bad + reason + score + tier) for an RFP.
 * Upserts the row — if no match_state exists yet, one is created with a
 * null pipeline status (RFP isn't in the tracker, but feedback is captured).
 */
export async function setMatchFeedback(
  userId: string,
  rfpId: string,
  feedback: MatchFeedback,
): Promise<void> {
  const existing = await db
    .select()
    .from(matchState)
    .where(and(eq(matchState.userId, userId), eq(matchState.rfpId, rfpId)))
    .limit(1);
  const feedbackAt = new Date(feedback.created_at);
  if (existing.length === 0) {
    await db.insert(matchState).values({
      userId,
      rfpId,
      feedbackRating: feedback.rating,
      feedbackReason: feedback.reason ?? null,
      matchScore: feedback.match_score,
      matchTier: feedback.match_tier,
      feedbackAt,
    });
    return;
  }
  await db
    .update(matchState)
    .set({
      feedbackRating: feedback.rating,
      feedbackReason: feedback.reason ?? null,
      matchScore: feedback.match_score,
      matchTier: feedback.match_tier,
      feedbackAt,
    })
    .where(eq(matchState.id, existing[0].id));
}

export async function removeMatchFeedback(userId: string, rfpId: string): Promise<void> {
  await db
    .update(matchState)
    .set({
      feedbackRating: null,
      feedbackReason: null,
      feedbackAt: null,
    })
    .where(and(eq(matchState.userId, userId), eq(matchState.rfpId, rfpId)));
}

/**
 * Return the set of (rfpId, status, statusChangedAt) for everything in
 * this user's tracker. Used by the /tracker page to build the calendar
 * and pipeline board.
 */
export async function getTrackerEntries(userId: string): Promise<
  Array<{ rfpId: string; status: PipelineStatus; statusChangedAt: Date | null }>
> {
  const rows = await db
    .select({
      rfpId: matchState.rfpId,
      status: matchState.status,
      statusChangedAt: matchState.statusChangedAt,
    })
    .from(matchState)
    .where(and(eq(matchState.userId, userId), isNotNull(matchState.status)));
  return rows
    .filter((r) => isPipelineStatus(r.status))
    .map((r) => ({
      rfpId: r.rfpId,
      status: r.status as PipelineStatus,
      statusChangedAt: r.statusChangedAt,
    }));
}
