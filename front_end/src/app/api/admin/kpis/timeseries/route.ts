/**
 * Time-series view over the daily KPI snapshots stored in S3.
 *
 *   GET /api/admin/kpis/timeseries?granularity=day|week|month
 *
 * The aggregator writes one snapshot per UTC day at
 *   metrics/aggregate/daily/{YYYY-MM-DD}.json
 * We read the recent N (by granularity), bucket them, and project a small
 * set of headline metrics per bucket. Heavier metrics (top filter values,
 * etc.) intentionally stay out — the time-series view is for trend lines,
 * not exhaustive drill-down.
 *
 * Reading the snapshots from S3 instead of recomputing means this stays
 * cheap even with a year of history — one ListObjectsV2 + N GetObject
 * calls, parallel-fanned, no DynamoDB.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listObjects, getObjectJSON } from "@/lib/s3";
import type { KpiSummary } from "@/lib/kpi-aggregator";

export const runtime = "nodejs";
export const maxDuration = 30;

type Granularity = "day" | "week" | "month";

interface SeriesPoint {
  bucket: string; // "2026-05-26" | "2026-W21" | "2026-05"
  bucketStart: string; // ISO date — useful for client charting
  // Headline metrics. These are pulled from the snapshot at the END of the
  // bucket (DAU/WAU/MAU are point-in-time gauges, not sums) except for
  // signups which are deltas, summed across days in the bucket.
  total_users: number;
  DAU: number;
  WAU: number;
  MAU: number;
  signups_in_bucket: number; // sum of signups.last_24h across the bucket
  cumulative_signups: number; // total at bucket end
  rfp_views_in_bucket: number; // sum from event_rollups (where available)
  rfp_saves_in_bucket: number;
  rfp_applies_in_bucket: number;
  proposals_generated: number;
  poes_generated: number;
}

const DAYS_BY_GRAN: Record<Granularity, number> = {
  day: 30,
  week: 12 * 7, // 12 weeks ≈ 84 days
  month: 12 * 31, // 12 months ≈ 372 days
};

function parseDateFromKey(key: string): Date | null {
  // metrics/aggregate/daily/2026-05-26.json
  const m = key.match(/(\d{4})-(\d{2})-(\d{2})\.json$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function isoWeekKey(d: Date): string {
  // ISO week: Thursday in week defines its year-week.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function isoWeekStart(d: Date): Date {
  // Monday of the ISO week containing d (UTC).
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 1);
  return tmp;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function bucketKey(d: Date, gran: Granularity): { key: string; start: Date } {
  switch (gran) {
    case "day":
      return {
        key: d.toISOString().slice(0, 10),
        start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())),
      };
    case "week":
      return { key: isoWeekKey(d), start: isoWeekStart(d) };
    case "month":
      return { key: monthKey(d), start: monthStart(d) };
  }
}

interface DailyPoint {
  date: Date;
  snap: KpiSummary;
}

function projectDaily(snap: KpiSummary): {
  total_users: number;
  DAU: number;
  WAU: number;
  MAU: number;
  signups_last_24h: number;
  cumulative_signups: number;
  rfp_views_total: number;
  rfp_saves_total: number;
  rfp_applies_total: number;
  proposals_generated: number;
  poes_generated: number;
} {
  return {
    total_users: snap.total_users,
    DAU: snap.active_users?.DAU ?? 0,
    WAU: snap.active_users?.WAU ?? 0,
    MAU: snap.active_users?.MAU ?? 0,
    signups_last_24h: snap.signups?.last_24h ?? 0,
    cumulative_signups: snap.signups?.total ?? 0,
    rfp_views_total: snap.satisfaction?.total_rfps_viewed ?? 0,
    rfp_saves_total: snap.satisfaction?.total_rfps_saved ?? 0,
    rfp_applies_total: snap.satisfaction?.total_rfps_applied ?? 0,
    proposals_generated: snap.satisfaction?.proposals_generated ?? 0,
    poes_generated: snap.satisfaction?.poes_generated ?? 0,
  };
}

function bucketize(points: DailyPoint[], gran: Granularity): SeriesPoint[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.date.getTime() - b.date.getTime());
  const buckets = new Map<
    string,
    {
      start: Date;
      lastSnap: KpiSummary;
      firstSnap: KpiSummary;
      signupsSum: number;
      // Track running deltas for cumulative-only metrics (RFP views, etc).
      // We compute the bucket delta as (last.cumulative - first_prior.cumulative).
    }
  >();

  for (const p of sorted) {
    const { key, start } = bucketKey(p.date, gran);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        start,
        firstSnap: p.snap,
        lastSnap: p.snap,
        signupsSum: p.snap.signups?.last_24h ?? 0,
      });
    } else {
      existing.lastSnap = p.snap;
      existing.signupsSum += p.snap.signups?.last_24h ?? 0;
    }
  }

  // For cumulative-delta metrics we need the snapshot just before each
  // bucket so the first day's delta isn't always = its absolute value.
  // Lookup table from sorted snapshots.
  const dateToCumulative = new Map<string, ReturnType<typeof projectDaily>>();
  for (const p of sorted) {
    dateToCumulative.set(p.date.toISOString().slice(0, 10), projectDaily(p.snap));
  }
  const sortedDateStrs = sorted
    .map((p) => p.date.toISOString().slice(0, 10))
    .sort();
  const priorOf = (firstDayInBucket: Date): ReturnType<typeof projectDaily> | null => {
    const firstStr = firstDayInBucket.toISOString().slice(0, 10);
    const idx = sortedDateStrs.indexOf(firstStr);
    if (idx <= 0) return null;
    return dateToCumulative.get(sortedDateStrs[idx - 1]) ?? null;
  };

  const series: SeriesPoint[] = [];
  for (const [key, b] of [...buckets.entries()].sort((a, b) => a[1].start.getTime() - b[1].start.getTime())) {
    const last = projectDaily(b.lastSnap);
    const prior = priorOf(b.start);
    series.push({
      bucket: key,
      bucketStart: b.start.toISOString(),
      total_users: last.total_users,
      DAU: last.DAU,
      WAU: last.WAU,
      MAU: last.MAU,
      signups_in_bucket: b.signupsSum,
      cumulative_signups: last.cumulative_signups,
      rfp_views_in_bucket: Math.max(0, last.rfp_views_total - (prior?.rfp_views_total ?? 0)),
      rfp_saves_in_bucket: Math.max(0, last.rfp_saves_total - (prior?.rfp_saves_total ?? 0)),
      rfp_applies_in_bucket: Math.max(0, last.rfp_applies_total - (prior?.rfp_applies_total ?? 0)),
      proposals_generated: last.proposals_generated,
      poes_generated: last.poes_generated,
    });
  }
  return series;
}

export async function GET(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const granParam = (url.searchParams.get("granularity") ?? "day").toLowerCase();
  const gran: Granularity =
    granParam === "week" || granParam === "month" ? granParam : "day";
  const windowDays = DAYS_BY_GRAN[gran];
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);

  try {
    const keys = await listObjects("metrics/aggregate/daily/");
    // Each key is metrics/aggregate/daily/YYYY-MM-DD.json. Parse → date,
    // drop anything older than the cutoff, then fan out GET in parallel.
    const recent: { key: string; date: Date }[] = [];
    for (const key of keys) {
      const d = parseDateFromKey(key);
      if (!d) continue;
      if (d.getTime() < cutoff.getTime()) continue;
      recent.push({ key, date: d });
    }
    recent.sort((a, b) => a.date.getTime() - b.date.getTime());

    const snaps = await Promise.all(
      recent.map(({ key, date }) =>
        getObjectJSON<KpiSummary>(key).then((snap) => (snap ? { date, snap } : null)),
      ),
    );
    const points = snaps.filter((s): s is DailyPoint => s !== null);

    const series = bucketize(points, gran);
    return NextResponse.json({
      granularity: gran,
      window_days: windowDays,
      points: series,
      snapshot_count: points.length,
    });
  } catch (err) {
    console.error("[admin/kpis/timeseries] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Timeseries failed" },
      { status: 500 },
    );
  }
}
