// POST /api/rfp-views — record that the authenticated user has now opened
// an RFP. Sets match_state.viewed_at on the (user, rfp) row, leaving the
// existing timestamp alone if one was already there (we only care about
// *first* view for the daily-roundup digest, not most recent).
//
// Fired by the RFP detail page once per RFP load. Fire-and-forget on the
// client side — failures don't block the user.

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { matchState } from "@/db/schema";

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rfpId =
    body && typeof body === "object" && "rfpId" in body
      ? (body as { rfpId?: unknown }).rfpId
      : undefined;
  if (typeof rfpId !== "string" || !rfpId) {
    return NextResponse.json({ error: "rfpId is required" }, { status: 400 });
  }

  const now = new Date();
  await db
    .insert(matchState)
    .values({ userId: auth.userId, rfpId, viewedAt: now })
    .onConflictDoUpdate({
      target: [matchState.userId, matchState.rfpId],
      // COALESCE keeps the existing first-view timestamp if there is one.
      // EXCLUDED references the row we tried to insert.
      set: { viewedAt: sql`COALESCE(${matchState.viewedAt}, EXCLUDED.viewed_at)` },
    });

  return NextResponse.json({ ok: true });
}
