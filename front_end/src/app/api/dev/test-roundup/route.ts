// TEMPORARY: preview-only test endpoint to render and send a sample daily
// roundup email. Used to validate the Resend migration end-to-end without
// having to opt a user in + wait until 7am local + accrue matches.
//
// Will be removed before the Resend migration PR merges to main. Guarded
// by VERCEL_ENV === 'preview' AND Vercel Deployment Protection (preview
// URLs require Vercel SSO).

import { NextResponse } from "next/server";
import { and, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rfpCache } from "@/db/schema";
import { visibleRfpSourceClause } from "@/lib/rfp-source-visibility";
import { sendDailyRoundupEmail, type RoundupRfp } from "@/lib/email";

export const runtime = "nodejs";

const SAMPLE_SCORES = [92, 88, 81, 76];

async function handle(request: Request) {
  if (process.env.VERCEL_ENV !== "preview" && process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not available in this environment" }, { status: 404 });
  }

  const url = new URL(request.url);
  const to = url.searchParams.get("to");
  if (!to) {
    return NextResponse.json({ error: "Missing ?to=<email>" }, { status: 400 });
  }

  const origin = process.env.CIVITAS_APP_ORIGIN ?? "https://civitas-ai.net";

  const rows = await db
    .select({
      id: rfpCache.id,
      title: rfpCache.title,
      agency: rfpCache.agency,
      deadline: rfpCache.deadline,
    })
    .from(rfpCache)
    .where(and(gte(rfpCache.deadline, new Date()), visibleRfpSourceClause()))
    .orderBy(sql`RANDOM()`)
    .limit(SAMPLE_SCORES.length);

  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No open RFPs in rfp_cache to sample from" },
      { status: 500 },
    );
  }

  const items: RoundupRfp[] = rows.map((r, i) => ({
    rfpId: r.id,
    title: r.title,
    agency: r.agency,
    matchScore: SAMPLE_SCORES[i] ?? 75,
    deadline: r.deadline ? r.deadline.toISOString().slice(0, 10) : null,
    detailUrl: `${origin}/dashboard/rfp/${encodeURIComponent(r.id)}`,
  }));

  const ok = await sendDailyRoundupEmail(to, items, origin);
  return NextResponse.json({ ok, to, count: items.length });
}

export const GET = handle;
export const POST = handle;
