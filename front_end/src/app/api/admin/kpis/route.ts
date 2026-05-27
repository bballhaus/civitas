/**
 * Admin KPI read + refresh.
 *
 *   GET   → returns metrics/aggregate/latest.json from S3 for the dashboard
 *   POST  → re-runs the aggregator on demand (same work as the daily cron)
 *
 * Both are gated by requireAdmin (session-cookie auth via JWT). The cron
 * endpoint at /api/admin/aggregate-kpis remains for unattended runs and uses
 * a CRON_SECRET instead — different surface, same underlying compute.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getObjectJSON } from "@/lib/s3";
import {
  computeAndStoreKpiSummary,
  type KpiSummary,
} from "@/lib/kpi-aggregator";

export const runtime = "nodejs";
export const maxDuration = 60;

const LATEST_KEY = "metrics/aggregate/latest.json";

export async function GET(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const summary = await getObjectJSON<KpiSummary>(LATEST_KEY);
    if (!summary) {
      return NextResponse.json(
        { error: "No KPI snapshot yet — run a refresh", snapshot: null },
        { status: 404 },
      );
    }
    return NextResponse.json({ snapshot: summary });
  } catch (err) {
    console.error("[admin/kpis] GET failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Read failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const summary = await computeAndStoreKpiSummary();
    return NextResponse.json({ ok: true, snapshot: summary });
  } catch (err) {
    console.error("[admin/kpis] refresh failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refresh failed" },
      { status: 500 },
    );
  }
}
