// POST /api/cron/daily-roundup — daily 7am-local digest sender.
//
// Triggered by an EventBridge cron (hourly, on the hour) that calls this
// route via a Lambda shim in `infra/notifications/`. Each invocation:
//
//   1. Selects opted-in users (profiles.daily_roundup_enabled = true)
//   2. Filters to those whose current local hour == DIGEST_HOUR
//      (uses Intl.DateTimeFormat with the IANA timezone captured at opt-in)
//   3. Skips users whose last send was within the dedupe window
//   4. For each remaining user: computes matches against rfp_cache, filters
//      to matchScore >= 75 AND not-yet-viewed, sends a digest if non-empty,
//      records the send timestamp
//
// Auth: shared bearer secret CIVITAS_CRON_SECRET. The route is intentionally
// not user-authenticated — it has to act on behalf of every opted-in user.

import { NextResponse } from "next/server";
import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { matchState, profiles, rfpCache, users } from "@/db/schema";
import { getFullProfile } from "@/db/queries/profile";
import { matchV2 } from "@/lib/matching-v2";
import { sendDailyRoundupEmail, type RoundupRfp } from "@/lib/email";
import { visibleRfpSourceClause } from "@/lib/rfp-source-visibility";

const DIGEST_HOUR = 7; // 7am local
const DEDUPE_HOURS = 23; // belt-and-suspenders against duplicate firings
const SCORE_THRESHOLD = 75;
const MAX_ROWS_PER_EMAIL = 10;

// We don't need anything else, so don't try to render on the edge.
export const runtime = "nodejs";

interface DueCandidate {
  userId: string;
  email: string;
  timezone: string;
}

function localHour(now: Date, timezone: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour")?.value;
    const h = hourPart ? Number(hourPart) : NaN;
    return Number.isFinite(h) ? h : null;
  } catch {
    // Bad IANA name — skip the user rather than crash the whole run.
    return null;
  }
}

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

  // Wrap the handler body so we always emit a structured JSON error
  // instead of a blank 500. Vercel's default 500 is content-length: 0,
  // which is impossible to debug from the EventBridge/Lambda side.
  try {
    return await runRoundup();
  } catch (err) {
    console.error("[cron/daily-roundup] handler crashed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Internal error", message },
      { status: 500 },
    );
  }
}

async function runRoundup() {
  const now = new Date();
  const dedupeCutoff = new Date(now.getTime() - DEDUPE_HOURS * 3600 * 1000);

  // Pull all opted-in users in one query. We re-filter in memory by local-hour
  // because we'd otherwise need a CASE-per-timezone in SQL, which is uglier
  // than a small JS loop. Volume is bounded by paid users, which stays small.
  const candidates = await db
    .select({
      userId: profiles.userId,
      email: users.email,
      timezone: profiles.dailyRoundupTimezone,
      lastSentAt: profiles.dailyRoundupLastSentAt,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.dailyRoundupEnabled, true));

  const due: DueCandidate[] = [];
  for (const c of candidates) {
    if (!c.timezone) continue;
    if (c.lastSentAt && c.lastSentAt > dedupeCutoff) continue;
    const h = localHour(now, c.timezone);
    if (h !== DIGEST_HOUR) continue;
    due.push({ userId: c.userId, email: c.email, timezone: c.timezone });
  }

  if (due.length === 0) {
    return NextResponse.json({ ok: true, evaluated: 0, sent: 0 });
  }

  // Load the open-RFP catalog once and share it across all due users —
  // it's identical input to every per-user match call.
  const openRfps = await db
    .select()
    .from(rfpCache)
    .where(and(gte(rfpCache.deadline, now), visibleRfpSourceClause()));

  const origin = process.env.CIVITAS_APP_ORIGIN ?? "";
  if (!origin) {
    // We need an absolute URL for the email's "open dashboard" links. If
    // unset the cron silently degrades (links point at relative paths,
    // which obviously won't work in an email client). Surface it loudly.
    console.warn(
      "[cron/daily-roundup] CIVITAS_APP_ORIGIN is not set — emails will have broken links",
    );
  }

  let sent = 0;
  let skippedEmptyDigest = 0;

  for (const c of due) {
    const profile = await getFullProfile(c.userId);
    if (!profile) continue;

    const scored = openRfps
      .map((rfp) => ({ rfp, m: matchV2(profile, rfp) }))
      .filter(({ m }) => m.score >= SCORE_THRESHOLD)
      .sort((a, b) => b.m.score - a.m.score);

    if (scored.length === 0) {
      skippedEmptyDigest++;
      continue;
    }

    // Pull every match_state row this user has against the candidate set;
    // exclude any already opened.
    const candidateIds = scored.map(({ rfp }) => rfp.id);
    const viewed = await db
      .select({ rfpId: matchState.rfpId })
      .from(matchState)
      .where(
        and(
          eq(matchState.userId, c.userId),
          inArray(matchState.rfpId, candidateIds),
          isNotNull(matchState.viewedAt),
        ),
      );
    const viewedSet = new Set(viewed.map((v) => v.rfpId));

    const unviewed = scored.filter(({ rfp }) => !viewedSet.has(rfp.id));
    if (unviewed.length === 0) {
      skippedEmptyDigest++;
      continue;
    }

    const top = unviewed.slice(0, MAX_ROWS_PER_EMAIL);
    const items: RoundupRfp[] = top.map(({ rfp, m }) => ({
      rfpId: rfp.id,
      title: rfp.title,
      agency: rfp.agency,
      matchScore: m.score,
      deadline: rfp.deadline ? rfp.deadline.toISOString().slice(0, 10) : null,
      detailUrl: `${origin}/matches/${encodeURIComponent(rfp.id)}`,
    }));

    const ok = await sendDailyRoundupEmail(c.email, items, origin);
    if (!ok) continue;

    await db
      .update(profiles)
      .set({ dailyRoundupLastSentAt: now, updatedAt: now })
      .where(eq(profiles.userId, c.userId));
    sent++;
  }

  return NextResponse.json({
    ok: true,
    evaluated: due.length,
    sent,
    skippedEmptyDigest,
  });
}
