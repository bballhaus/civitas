/**
 * Daily KPI aggregator endpoint.
 *
 * Reads civitas-kpi-users from DynamoDB, computes the rolled-up summary,
 * and writes it to S3 at:
 *   - metrics/aggregate/daily/{YYYY-MM-DD}.json   (historical snapshot)
 *   - metrics/aggregate/latest.json               (canonical current view)
 *
 * Triggered by Vercel Cron (see vercel.json). Auth is via the standard
 * Vercel Cron header: `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Manual run (during dev or one-off backfill):
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<deployment>/api/admin/aggregate-kpis
 */
import { NextResponse } from "next/server";
import { computeAndStoreKpiSummary } from "@/lib/kpi-aggregator";

export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const summary = await computeAndStoreKpiSummary();
    return NextResponse.json({
      ok: true,
      computed_at: summary.computed_at,
      total_users: summary.total_users,
      active_users: summary.active_users,
    });
  } catch (err) {
    console.error("[aggregate-kpis] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Aggregation failed" },
      { status: 500 }
    );
  }
}

// Allow manual POST as well (some Cron platforms post)
export async function POST(request: Request) {
  return GET(request);
}
