// POST /api/cron/rebuild-match-state — full rebuild of the match_state cache.
//
// Use cases:
//   1. Initial backfill after deploying the background-rescore migration —
//      existing users get every visible future-deadline RFP scored once.
//   2. Disaster recovery if the cache gets desynced (e.g. matching-v2
//      semantics change).
//   3. Periodic safety net — wire to an EventBridge cron (e.g. nightly) if
//      you want belt-and-suspenders against missed profile-write triggers.
//
// Auth: shared bearer secret CIVITAS_CRON_SECRET (same as sync-rfp-cache /
// daily-roundup).
//
// Behavior: scores every visible future-deadline RFP against every user.
// Upserts the cache columns ONLY — never touches status / feedback / viewedAt
// (see lib/match-rescore.ts invariants). Clears matchScoresPendingSince for
// each user as their rescore finishes.

import { NextResponse } from "next/server";
import { rebuildAllMatchState } from "@/lib/match-rescore";

export const runtime = "nodejs";
// Full rebuild is the slowest cron path — give it the Pro tier maximum.
export const maxDuration = 300;

export async function POST(request: Request) {
  const expected = process.env.CIVITAS_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "CIVITAS_CRON_SECRET is not set" },
      { status: 500 },
    );
  }
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await rebuildAllMatchState();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[cron/rebuild-match-state] handler crashed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Internal error", message },
      { status: 500 },
    );
  }
}
