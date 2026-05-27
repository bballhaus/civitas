"use client";

// Dev-only KPI dashboard. Reads /api/admin/kpis (which proxies the daily S3
// snapshot at metrics/aggregate/latest.json) plus /api/admin/events for raw
// drill-down. Admin allowlist enforced server-side; the client only renders
// what the API returns. See lib/admin-auth.ts for the gate.
//
// No charting library — all viz is plain CSS bars + tables. Keeps the bundle
// light and the page works in any browser without JS framework gymnastics.

import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";
import type { KpiSummary } from "@/lib/kpi-aggregator";
import { ALL_EVENT_TYPES } from "@/lib/events";

interface AdminKpisResponse {
  snapshot: KpiSummary | null;
  error?: string;
}

interface AdminEventRow {
  type: string;
  timestamp: string;
  username?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

interface AdminEventsResponse {
  type: string;
  count: number;
  events: AdminEventRow[];
  error?: string;
}

type Granularity = "day" | "week" | "month";

interface TimeseriesPoint {
  bucket: string;
  bucketStart: string;
  total_users: number;
  DAU: number;
  WAU: number;
  MAU: number;
  signups_in_bucket: number;
  cumulative_signups: number;
  rfp_views_in_bucket: number;
  rfp_saves_in_bucket: number;
  rfp_applies_in_bucket: number;
  proposals_generated: number;
  poes_generated: number;
}

interface TimeseriesResponse {
  granularity: Granularity;
  window_days: number;
  points: TimeseriesPoint[];
  snapshot_count: number;
}

export default function AdminKpisPage() {
  const [summary, setSummary] = useState<KpiSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drillType, setDrillType] = useState<string>("filter_applied");
  const [drillRows, setDrillRows] = useState<AdminEventRow[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [timeseriesLoading, setTimeseriesLoading] = useState(false);

  const fetchSummary = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/kpis", { cache: "no-store" });
      if (res.status === 401) {
        setError("Not authorized — only admin emails can view this page.");
        setSummary(null);
        return;
      }
      const data = (await res.json()) as AdminKpisResponse;
      if (!res.ok) {
        setError(data.error ?? `Failed to load KPIs (${res.status})`);
        setSummary(null);
        return;
      }
      setSummary(data.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load KPIs");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDrill = useCallback(async (type: string) => {
    setDrillLoading(true);
    try {
      const res = await fetch(
        `/api/admin/events?type=${encodeURIComponent(type)}&limit=50`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        setDrillRows([]);
        return;
      }
      const data = (await res.json()) as AdminEventsResponse;
      setDrillRows(data.events ?? []);
    } catch {
      setDrillRows([]);
    } finally {
      setDrillLoading(false);
    }
  }, []);

  const fetchTimeseries = useCallback(async (gran: Granularity) => {
    setTimeseriesLoading(true);
    try {
      const res = await fetch(`/api/admin/kpis/timeseries?granularity=${gran}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setTimeseries([]);
        return;
      }
      const data = (await res.json()) as TimeseriesResponse;
      setTimeseries(data.points ?? []);
    } catch {
      setTimeseries([]);
    } finally {
      setTimeseriesLoading(false);
    }
  }, []);

  const refreshSnapshot = useCallback(
    async (mode: "manual" | "auto") => {
      if (mode === "manual") setRefreshing(true);
      else setAutoRefreshing(true);
      try {
        const res = await fetch("/api/admin/kpis", { method: "POST" });
        if (res.ok) {
          const data = (await res.json()) as { snapshot: KpiSummary };
          setSummary(data.snapshot);
          setError(null);
          // A fresh snapshot may have generated a new daily file in S3 —
          // re-fetch the series so the latest day shows up.
          void fetchTimeseries(granularity);
        } else if (mode === "manual") {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? `Refresh failed (${res.status})`);
        }
        // Auto-refresh failures are silent — the cached snapshot is fine.
      } catch (err) {
        if (mode === "manual") {
          setError(err instanceof Error ? err.message : "Refresh failed");
        }
      } finally {
        if (mode === "manual") setRefreshing(false);
        else setAutoRefreshing(false);
      }
    },
    [fetchTimeseries, granularity],
  );

  // On mount: render the cached snapshot immediately (fast), then kick off
  // a background refresh so the next render has fresh data. The cached
  // path is the only place we set `loading`; the auto-refresh uses its
  // own indicator. Two effects so we don't refetch when granularity flips.
  useEffect(() => {
    void fetchSummary().then(() => {
      void refreshSnapshot("auto");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetchDrill(drillType);
  }, [drillType, fetchDrill]);

  useEffect(() => {
    void fetchTimeseries(granularity);
  }, [granularity, fetchTimeseries]);

  const onRefresh = useCallback(() => refreshSnapshot("manual"), [refreshSnapshot]);

  if (loading) {
    return (
      <Frame>
        <p className="text-sm text-slate-600">Loading KPIs…</p>
      </Frame>
    );
  }

  if (error && !summary) {
    return (
      <Frame>
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold disabled:opacity-60"
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      </Frame>
    );
  }

  if (!summary) {
    return (
      <Frame>
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800 flex items-center justify-between gap-3">
          <span>No KPI snapshot found yet. Run a refresh to build one.</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold disabled:opacity-60"
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">KPI dashboard</h1>
          <p className="text-xs text-slate-500 mt-1 flex items-center gap-2">
            <span>
              Snapshot {humanAgo(summary.computed_at)} · event rollups span last{" "}
              {summary.event_rollups?.window_days ?? 30} days
            </span>
            {autoRefreshing && (
              <span className="inline-flex items-center gap-1 text-[#3C89C6] font-semibold">
                <span className="inline-block w-2 h-2 rounded-full bg-[#3C89C6] animate-pulse" />
                refreshing…
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="px-4 py-2 rounded-lg bg-[#3C89C6] text-white text-sm font-semibold hover:bg-[#2d6fa0] disabled:opacity-60"
        >
          {refreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      {/* Top-line totals */}
      <Section title="Active users">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total users" value={summary.total_users} />
          <Stat
            label="DAU — daily (last 24h)"
            value={summary.active_users.DAU}
            help="Distinct users with any activity in the last 24 hours."
          />
          <Stat
            label="WAU — weekly (last 7d)"
            value={summary.active_users.WAU}
            help="Distinct users with any activity in the last 7 days."
          />
          <Stat
            label="MAU — monthly (last 30d)"
            value={summary.active_users.MAU}
            help="Distinct users with any activity in the last 30 days."
          />
        </div>
      </Section>

      <Section
        title="Trends over time"
        right={
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
            {(["day", "week", "month"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGranularity(g)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  granularity === g
                    ? "bg-[#3C89C6] text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {g === "day" ? "30d" : g === "week" ? "12w" : "12mo"}
              </button>
            ))}
          </div>
        }
      >
        {timeseriesLoading && timeseries.length === 0 ? (
          <p className="text-sm text-slate-400">Loading series…</p>
        ) : timeseries.length === 0 ? (
          <p className="text-sm text-slate-400 italic">
            No snapshots yet — they accumulate one per day from the cron + on-demand refreshes.
          </p>
        ) : (
          <div className="space-y-5">
            <TimeseriesChart
              title="New signups per bucket"
              help="How many users completed signup in each bucket."
              points={timeseries}
              metric="signups_in_bucket"
            />
            <TimeseriesChart
              title="DAU — daily active users (any activity in last 24h)"
              help="Distinct users with any tracked activity in the last 24 hours, measured at the end of each bucket."
              points={timeseries}
              metric="DAU"
            />
            <TimeseriesChart
              title="WAU — weekly active users (any activity in last 7d)"
              help="Distinct users with any tracked activity in the last 7 days, measured at the end of each bucket."
              points={timeseries}
              metric="WAU"
            />
            <TimeseriesChart
              title="MAU — monthly active users (any activity in last 30d)"
              help="Distinct users with any tracked activity in the last 30 days, measured at the end of each bucket."
              points={timeseries}
              metric="MAU"
            />
            <TimeseriesChart
              title="RFP detail views per bucket"
              help="Number of RFP detail pages opened, summed across users in each bucket."
              points={timeseries}
              metric="rfp_views_in_bucket"
            />
            <TimeseriesChart
              title="RFPs saved per bucket"
              help="How many RFPs users saved to their tracker in each bucket."
              points={timeseries}
              metric="rfp_saves_in_bucket"
            />
            <TimeseriesChart
              title="RFPs applied to per bucket"
              help="How many RFPs users marked as bid-submitted in each bucket."
              points={timeseries}
              metric="rfp_applies_in_bucket"
            />
            <TimeseriesChart
              title="Cumulative signups (all-time)"
              help="Running total of accounts created."
              points={timeseries}
              metric="cumulative_signups"
            />
          </div>
        )}
      </Section>

      <Section title="Signups">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Last 24h" value={summary.signups.last_24h} />
          <Stat label="Last 7d" value={summary.signups.last_7d} />
          <Stat label="Last 30d" value={summary.signups.last_30d} />
          <Stat label="All time" value={summary.signups.total} />
        </div>
      </Section>

      <Section title="Funnel totals">
        <SimpleBarTable
          rows={Object.entries(summary.funnel_totals).map(([k, v]) => ({
            label: k,
            value: v,
          }))}
        />
      </Section>

      <Section title="Funnel conversion (%)">
        <SimpleBarTable
          rows={Object.entries(summary.funnel_conversion_rates).map(([k, v]) => ({
            label: k,
            value: v,
            suffix: "%",
            max: 100,
          }))}
        />
      </Section>

      <Section title="Satisfaction & generation">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Proposals generated" value={summary.satisfaction.proposals_generated} />
          <Stat label="Proposals regenerated" value={summary.satisfaction.proposals_regenerated} />
          <Stat
            label="Proposal acceptance %"
            value={summary.satisfaction.proposal_acceptance_rate}
            suffix="%"
          />
          <Stat label="POEs generated" value={summary.satisfaction.poes_generated} />
          <Stat label="POEs regenerated" value={summary.satisfaction.poes_regenerated} />
          <Stat
            label="POE acceptance %"
            value={summary.satisfaction.poe_acceptance_rate}
            suffix="%"
          />
          <Stat label="Total logins" value={summary.satisfaction.total_logins} />
          <Stat label="Total RFP views" value={summary.satisfaction.total_rfps_viewed} />
        </div>
      </Section>

      <Section title="RFP click-through (last 30d)">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Impressions" value={summary.event_rollups.rfp_ctr.impressions} />
          <Stat label="Views" value={summary.event_rollups.rfp_ctr.views} />
          <Stat label="CTR %" value={summary.event_rollups.rfp_ctr.ctr} suffix="%" />
          <Stat label="Attachment clicks" value={summary.event_rollups.rfp_attachment_clicks} />
          <Stat
            label="External-link clicks"
            value={summary.event_rollups.rfp_external_link_clicks}
          />
          <Stat
            label="Dwell median (s)"
            value={
              summary.event_rollups.rfp_dwell_ms_median
                ? Math.round(summary.event_rollups.rfp_dwell_ms_median / 100) / 10
                : 0
            }
            suffix="s"
          />
          <Stat
            label="Dwell p90 (s)"
            value={
              summary.event_rollups.rfp_dwell_ms_p90
                ? Math.round(summary.event_rollups.rfp_dwell_ms_p90 / 100) / 10
                : 0
            }
            suffix="s"
          />
        </div>
      </Section>

      <Section title="RFP detail — sections expanded">
        <KeyValueTable counts={summary.event_rollups.rfp_section_expansions} />
      </Section>

      <Section title="Top filter values applied">
        {summary.event_rollups.top_filter_values.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left py-2 px-2">Filter</th>
                <th className="text-left py-2 px-2">Values</th>
                <th className="text-right py-2 px-2">Count</th>
              </tr>
            </thead>
            <tbody>
              {summary.event_rollups.top_filter_values.map((r, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-1.5 px-2 font-medium text-slate-800">{r.filterName}</td>
                  <td className="py-1.5 px-2 text-slate-600 break-all">{r.filterValues || "—"}</td>
                  <td className="py-1.5 px-2 text-right font-semibold">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Filters cleared">
        <KeyValueTable counts={summary.event_rollups.filter_cleared_counts} />
      </Section>

      <Section title="Search behavior">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-bold uppercase text-slate-500 mb-2">Query length</p>
            <SimpleBarTable
              rows={summary.event_rollups.top_search_lengths.map((r) => ({
                label: r.bucket,
                value: r.count,
              }))}
            />
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-slate-500 mb-2">Zero-result rate</p>
            <Stat
              label="% of searches returning 0"
              value={summary.event_rollups.search_zero_result_rate}
              suffix="%"
            />
          </div>
        </div>
      </Section>

      <Section title="Sort choices">
        <KeyValueTable counts={summary.event_rollups.sort_key_distribution} />
      </Section>

      <Section title="Onboarding — median time per step (s)">
        <KeyValueTable
          counts={Object.fromEntries(
            Object.entries(summary.event_rollups.onboarding_step_dwell_ms_median).map(
              ([step, ms]) => [step, Math.round(ms / 100) / 10],
            ),
          )}
          suffix="s"
        />
      </Section>

      <Section title="Onboarding — skip rate (%)">
        <KeyValueTable counts={summary.event_rollups.onboarding_step_skip_rate} suffix="%" />
      </Section>

      <Section title="Onboarding — validation errors (step::field)">
        <KeyValueTable counts={summary.event_rollups.onboarding_validation_errors} />
      </Section>

      <Section title="Homepage CTAs">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-bold uppercase text-slate-500 mb-2">CTA clicks</p>
            <KeyValueTable counts={summary.event_rollups.home_cta_distribution} />
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-slate-500 mb-2">Widget views</p>
            <KeyValueTable counts={summary.event_rollups.home_widget_views} />
          </div>
        </div>
      </Section>

      <Section title="Tracker — status transitions">
        <KeyValueTable counts={summary.event_rollups.tracker_status_transitions} />
      </Section>

      <Section title="Tracker — notes">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Notes added" value={summary.event_rollups.tracker_notes_added} />
          <Stat label="Notes edited" value={summary.event_rollups.tracker_notes_edited} />
        </div>
      </Section>

      <Section title="All event counts (last 30d)">
        <KeyValueTable counts={summary.event_rollups.event_counts} />
      </Section>

      <Section title="Per-user spread (across all users with any activity)">
        <UserDistributionTable distributions={summary.user_distributions ?? {}} />
      </Section>

      <Section title="Per-user breakdown">
        <PerUserTable users={summary.per_user} />
      </Section>

      <Section title="Drill-down — raw events">
        <div className="flex items-center gap-2 mb-3">
          <label className="text-xs font-semibold text-slate-600">Type:</label>
          <select
            value={drillType}
            onChange={(e) => setDrillType(e.target.value)}
            className="px-2 py-1 text-sm border border-slate-300 rounded-md"
          >
            {ALL_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {drillLoading && <span className="text-xs text-slate-400">Loading…</span>}
        </div>
        {drillRows.length === 0 ? (
          <Empty />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="text-left py-1.5 px-2">When</th>
                  <th className="text-left py-1.5 px-2">User</th>
                  <th className="text-left py-1.5 px-2">Payload</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {drillRows.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100 align-top">
                    <td className="py-1 px-2 text-slate-500 whitespace-nowrap">
                      {r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}
                    </td>
                    <td className="py-1 px-2 text-slate-700 whitespace-nowrap">
                      {r.username ?? "—"}
                    </td>
                    <td className="py-1 px-2 text-slate-800 break-all">
                      {r.payload ? JSON.stringify(r.payload) : "{}"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />
      <main className="relative max-w-6xl mx-auto px-6 md:px-10 py-10">{children}</main>
    </div>
  );
}

function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className="mb-6 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-5">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function humanAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "computed at unknown time";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return `computed ${diffSec}s ago`;
  if (diffSec < 3600) return `computed ${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `computed ${Math.round(diffSec / 3600)}h ago`;
  return `computed ${Math.round(diffSec / 86_400)}d ago`;
}

function TimeseriesChart({
  title,
  help,
  points,
  metric,
}: {
  title: string;
  help?: string;
  points: TimeseriesPoint[];
  metric: keyof TimeseriesPoint;
}) {
  // SVG line chart with proper axes. ViewBox uses a fixed coordinate space
  // (W × H) so every chart renders identically regardless of container width.
  // preserveAspectRatio="none" lets the plot stretch horizontally to fill the
  // slot. Axis labels live inside the same SVG so they scale with the chart.
  const values = points.map((p) => Number(p[metric] ?? 0));
  const rawMax = Math.max(...values, 1);
  // Round max up to a "nice" number so Y-axis ticks come out clean
  // (e.g. 87 → 100, 17 → 20). Without this the tick labels get noisy.
  const niceMax = niceCeil(rawMax);
  const last = values[values.length - 1] ?? 0;

  const W = 800;
  const H = 140;
  const PAD_LEFT = 44;
  const PAD_RIGHT = 12;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 24;
  const plotW = W - PAD_LEFT - PAD_RIGHT;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  const yFor = (v: number) => {
    if (niceMax <= 0) return PAD_TOP + plotH;
    return PAD_TOP + plotH * (1 - v / niceMax);
  };
  const xFor = (i: number) => {
    if (points.length <= 1) return PAD_LEFT + plotW;
    return PAD_LEFT + (plotW * i) / (points.length - 1);
  };

  const linePath = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(2)},${yFor(v).toFixed(2)}`)
    .join(" ");
  const areaPath =
    values.length > 0
      ? `${linePath} L${xFor(values.length - 1).toFixed(2)},${PAD_TOP + plotH} L${xFor(0).toFixed(2)},${PAD_TOP + plotH} Z`
      : "";

  // Y-axis ticks: 5 evenly spaced. Each tick gets a gridline + label.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    frac,
    value: Math.round(niceMax * frac),
    y: PAD_TOP + plotH * (1 - frac),
  }));
  // X-axis ticks: pick a handful of evenly spaced indices. Fewer when the
  // labels would overlap (long ISO dates take ~70px each at this font size).
  const tickCount = Math.min(points.length, points.length <= 12 ? points.length : 6);
  const xTickIndices: number[] = [];
  if (points.length > 0) {
    if (tickCount <= 1) xTickIndices.push(0);
    else for (let i = 0; i < tickCount; i++) {
      xTickIndices.push(Math.round((i * (points.length - 1)) / (tickCount - 1)));
    }
  }

  return (
    <div title={help}>
      <div className="flex items-baseline justify-between mb-1">
        <p className="text-xs font-semibold text-slate-800">{title}</p>
        <p className="text-[11px] text-slate-600">
          max <span className="font-semibold text-slate-800">{rawMax}</span> · latest{" "}
          <span className="font-semibold text-slate-800">{last}</span> · {points.length}{" "}
          {points.length === 1 ? "point" : "points"}
        </p>
      </div>
      {points.length === 0 ? (
        <div className="h-32 flex items-center justify-center bg-slate-50 rounded border border-slate-100 text-xs text-slate-400">
          No snapshots in window — the chart fills in as days accumulate.
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-32 bg-slate-50 rounded border border-slate-100"
        >
          {/* Y-axis gridlines + tick labels. Dashed for inner ticks, solid for the baseline. */}
          {yTicks.map((t) => (
            <g key={t.frac}>
              <line
                x1={PAD_LEFT}
                x2={W - PAD_RIGHT}
                y1={t.y}
                y2={t.y}
                stroke="#e2e8f0"
                strokeWidth="1"
                strokeDasharray={t.frac === 0 ? "0" : "2,3"}
              />
              <text
                x={PAD_LEFT - 6}
                y={t.y + 3}
                textAnchor="end"
                className="fill-slate-500"
                style={{ fontSize: 10 }}
              >
                {t.value}
              </text>
            </g>
          ))}
          {/* Y-axis line. */}
          <line
            x1={PAD_LEFT}
            x2={PAD_LEFT}
            y1={PAD_TOP}
            y2={PAD_TOP + plotH}
            stroke="#cbd5e1"
            strokeWidth="1"
          />
          {/* X-axis ticks + labels at evenly spaced bucket indices. */}
          {xTickIndices.map((i) => (
            <g key={i}>
              <line
                x1={xFor(i)}
                x2={xFor(i)}
                y1={PAD_TOP + plotH}
                y2={PAD_TOP + plotH + 4}
                stroke="#cbd5e1"
                strokeWidth="1"
              />
              <text
                x={xFor(i)}
                y={PAD_TOP + plotH + 16}
                textAnchor="middle"
                className="fill-slate-500"
                style={{ fontSize: 10 }}
              >
                {formatBucketShort(points[i].bucket)}
              </text>
            </g>
          ))}
          {/* Filled area under the line for visual weight. */}
          {points.length > 1 && (
            <path d={areaPath} fill="#3C89C6" fillOpacity="0.12" />
          )}
          {/* The line itself. */}
          {points.length > 1 && (
            <path
              d={linePath}
              fill="none"
              stroke="#3C89C6"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {/* Dot per point — readable when count is small, dense when not. */}
          {points.map((p, i) => (
            <circle
              key={p.bucket}
              cx={xFor(i)}
              cy={yFor(values[i])}
              r={points.length > 30 ? 1.5 : 3}
              fill="#3C89C6"
              stroke="white"
              strokeWidth={points.length > 30 ? 0.5 : 1.5}
            >
              <title>{`${p.bucket}: ${values[i]}`}</title>
            </circle>
          ))}
        </svg>
      )}
    </div>
  );
}

/**
 * Round a positive number up to a "nice" axis maximum. Picks the smallest
 * value of the form {1,2,2.5,5,10} × 10ⁿ that's >= v. Yields clean tick
 * labels (10, 20, 25, 50, 100, …) instead of arbitrary values like 87.
 */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const norm = v / base; // ∈ [1, 10)
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 2.5) nice = 2.5;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

/**
 * Shorten a bucket key for the X-axis. Daily snapshots become "May 27",
 * weeks stay "W21", months become "May".
 */
function formatBucketShort(bucket: string): string {
  // Daily: "2026-05-27"
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
    const d = new Date(`${bucket}T00:00:00Z`);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  // Monthly: "2026-05"
  if (/^\d{4}-\d{2}$/.test(bucket)) {
    const [y, m] = bucket.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });
  }
  // Weekly: "2026-W21" — keep the W## part; year is implied by context.
  const wk = bucket.match(/W(\d{2})/);
  if (wk) return `W${wk[1]}`;
  return bucket;
}

function Stat({
  label,
  value,
  suffix,
  help,
}: {
  label: string;
  value: number;
  suffix?: string;
  help?: string;
}) {
  return (
    <div
      className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3"
      title={help}
    >
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-2xl font-extrabold text-slate-900">
        {value}
        {suffix && <span className="text-base font-bold text-slate-700 ml-0.5">{suffix}</span>}
      </p>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-slate-400 italic">No events in window.</p>;
}

function SimpleBarTable({
  rows,
}: {
  rows: Array<{ label: string; value: number; suffix?: string; max?: number }>;
}) {
  if (rows.length === 0) return <Empty />;
  const max = Math.max(...rows.map((r) => r.max ?? r.value), 1);
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-xs text-slate-700 font-medium w-40 truncate">{r.label}</span>
          <div className="flex-1 h-4 bg-slate-100 rounded overflow-hidden">
            <div
              className="h-full bg-[#3C89C6]"
              style={{ width: `${Math.min(100, (r.value / max) * 100)}%` }}
            />
          </div>
          <span className="text-xs font-bold text-slate-800 w-16 text-right">
            {r.value}
            {r.suffix ?? ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function KeyValueTable({
  counts,
  suffix,
}: {
  counts: Record<string, number>;
  suffix?: string;
}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <Empty />;
  const max = Math.max(...entries.map(([, v]) => v), 1);
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-3">
          <span className="text-xs text-slate-700 font-medium w-56 truncate" title={k}>
            {k}
          </span>
          <div className="flex-1 h-3 bg-slate-100 rounded overflow-hidden">
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${Math.min(100, (v / max) * 100)}%` }}
            />
          </div>
          <span className="text-xs font-bold text-slate-800 w-16 text-right">
            {v}
            {suffix ?? ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function PerUserTable({ users }: { users: KpiSummary["per_user"] }) {
  if (users.length === 0) return <Empty />;
  const sorted = [...users].sort(
    (a, b) =>
      (b.last_active_at ? Date.parse(b.last_active_at) : 0) -
      (a.last_active_at ? Date.parse(a.last_active_at) : 0),
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
          <tr>
            <th className="text-left py-1.5 px-2">User</th>
            <th className="text-left py-1.5 px-2">Signed up</th>
            <th className="text-left py-1.5 px-2">Last active</th>
            <th className="text-right py-1.5 px-2">RFP views</th>
            <th className="text-right py-1.5 px-2">Saved</th>
            <th className="text-right py-1.5 px-2">Applied</th>
            <th className="text-right py-1.5 px-2">Sessions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((u) => (
            <tr key={u.username} className="border-b border-slate-100">
              <td className="py-1 px-2 font-medium text-slate-900">{u.username}</td>
              <td className="py-1 px-2 text-slate-700">
                {u.signup_at ? new Date(u.signup_at).toLocaleDateString() : "—"}
              </td>
              <td className="py-1 px-2 text-slate-700">
                {u.last_active_at
                  ? `${u.days_since_last_active ?? "?"}d ago`
                  : "—"}
              </td>
              <td className="py-1 px-2 text-right text-slate-800">{u.counters.counter_rfps_viewed ?? 0}</td>
              <td className="py-1 px-2 text-right text-slate-800">{u.counters.counter_rfps_saved ?? 0}</td>
              <td className="py-1 px-2 text-right text-slate-800">{u.counters.counter_rfps_applied ?? 0}</td>
              <td className="py-1 px-2 text-right text-slate-800">{u.counters.counter_sessions ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserDistributionTable({
  distributions,
}: {
  distributions: NonNullable<KpiSummary["user_distributions"]>;
}) {
  const entries = Object.entries(distributions).sort(
    (a, b) => b[1].total - a[1].total,
  );
  if (entries.length === 0) return <Empty />;
  // Shorten the counter_ prefix that's baked into our schema — pure
  // presentation.
  const label = (k: string) => k.replace(/^counter_/, "").replace(/_/g, " ");
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-[10px] uppercase tracking-wider text-slate-600 border-b border-slate-200">
          <tr>
            <th className="text-left py-1.5 px-2">Metric</th>
            <th className="text-right py-1.5 px-2" title="Number of users with a non-zero count">
              Users with
            </th>
            <th className="text-right py-1.5 px-2" title="Sum across all users">Total</th>
            <th className="text-right py-1.5 px-2" title="Average across users with non-zero count">
              Mean
            </th>
            <th className="text-right py-1.5 px-2" title="Median value (typical user)">Median</th>
            <th className="text-right py-1.5 px-2" title="90th percentile (heavy users)">P90</th>
            <th className="text-right py-1.5 px-2" title="Highest single user">Max</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, d]) => (
            <tr key={k} className="border-b border-slate-100">
              <td className="py-1.5 px-2 font-medium text-slate-900">{label(k)}</td>
              <td className="py-1.5 px-2 text-right text-slate-700">{d.users_with_value}</td>
              <td className="py-1.5 px-2 text-right font-semibold text-slate-900">{d.total}</td>
              <td className="py-1.5 px-2 text-right text-slate-800">{d.mean}</td>
              <td className="py-1.5 px-2 text-right text-slate-800">{d.median}</td>
              <td className="py-1.5 px-2 text-right text-slate-800">{d.p90}</td>
              <td className="py-1.5 px-2 text-right text-slate-800">{d.max}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
