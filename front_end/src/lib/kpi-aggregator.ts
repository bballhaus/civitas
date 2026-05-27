/**
 * KPI aggregator. Reads the per-user summary table (civitas-kpi-users)
 * and produces a single rolled-up document for internal review.
 *
 * Output shape is designed to be human-readable from `aws s3 cp ... -`
 * — the user views KPIs by reading these JSON files directly.
 *
 * Scans rather than queries because pre-launch the user count is small
 * and the entire table fits in one in-memory pass. Switch to GSI queries
 * + parallelism when this stops being true.
 */
import { ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  getDynamoClient,
  getKpiEventsTable,
  getKpiUsersTable,
} from "./dynamodb";
import { putObjectJSON } from "./s3";
import { TEST_USERS, TEST_EMAILS, isTestEmail } from "./test-users";
import { db } from "@/db/client";
import { users as usersTable } from "@/db/schema";

/**
 * Resolve the test-user list into a flat set of usernames by joining the
 * username-based TEST_USERS_RAW with any Postgres users whose email lands in
 * TEST_EMAILS_RAW. One Postgres query per aggregator run — cheap.
 *
 * Falls back to the static TEST_USERS set if the Postgres lookup fails, so
 * email-based test users may temporarily leak through but the rest still
 * filters correctly.
 */
async function resolveTestUsernames(): Promise<ReadonlySet<string>> {
  const out = new Set(TEST_USERS);
  // Also treat every test EMAIL as a direct username match. Some events
  // recorded the email string into the username field (e.g. abandoned
  // signups where the prospective username happened to be the email, or
  // older code paths). Adding the emails here catches those rows without
  // requiring a Postgres user row to exist.
  for (const e of TEST_EMAILS) out.add(e);
  // Plus: any Postgres user whose email matches the test-email list — this
  // catches "real" accounts that completed signup with a test email but
  // chose a non-email-shaped username.
  try {
    const rows = await db
      .select({ username: usersTable.username, email: usersTable.email })
      .from(usersTable);
    for (const r of rows) {
      if (isTestEmail(r.email)) out.add(r.username.toLowerCase());
    }
  } catch (err) {
    console.warn("[kpi-aggregator] test-email resolution failed; falling back to static lists:", err);
  }
  return out;
}

// Event types whose payloads we roll up beyond raw counters. Aggregations are
// done by scanning the byEventType GSI on civitas-kpi-events for events from
// the last EVENT_WINDOW_DAYS days. Keep this list small — each entry triggers
// a GSI Query.
const ROLLUP_EVENT_TYPES = [
  "filter_applied",
  "filter_cleared",
  "rfp_impression",
  "rfp_viewed",
  "rfp_section_expanded",
  "rfp_attachment_clicked",
  "rfp_external_link_clicked",
  "rfp_dwell",
  "home_cta_clicked",
  "home_widget_viewed",
  "home_recent_match_clicked",
  "tracker_column_viewed",
  "tracker_status_changed_from_tracker",
  "tracker_note_added",
  "tracker_note_edited",
  "onboarding_step_dwell",
  "onboarding_step_viewed",
  "onboarding_step_skipped",
  "onboarding_validation_error",
  "search_submitted",
  "search_result_count",
  "sort_changed",
  "page_viewed",
] as const;

/**
 * Map a raw pagePath to a stable category. Detail pages (`/matches/abc123`)
 * collapse to `rfp_detail` so per-user counts aren't fragmented across every
 * RFP UUID; everything else keeps its top-level segment.
 */
function pageCategory(rawPath: string | undefined | null): string {
  const p = (rawPath ?? "").toLowerCase();
  if (!p) return "unknown";
  if (p.startsWith("/matches/") || p.startsWith("/dashboard/rfp/")) return "rfp_detail";
  if (p === "/home" || p.startsWith("/home")) return "home";
  if (p === "/dashboard" || p.startsWith("/dashboard")) return "dashboard";
  if (p === "/matches" || p.startsWith("/matches")) return "matches";
  if (p === "/tracker" || p.startsWith("/tracker")) return "tracker";
  if (p.startsWith("/profile")) return "profile";
  if (p.startsWith("/onboarding")) return "onboarding";
  if (p.startsWith("/contracts")) return "contracts";
  if (p.startsWith("/upload")) return "upload";
  if (p === "/" || p === "") return "root";
  return p.split("/")[1] ?? "other";
}

const EVENT_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

interface UserSummary {
  username: string;
  signup_at?: string;
  cohort_week?: string;
  last_active_at?: string;
  funnel: Record<string, string>;
  counters: Record<string, number>;
}

export interface KpiSummary {
  computed_at: string;
  total_users: number;
  active_users: { DAU: number; WAU: number; MAU: number };
  signups: { last_24h: number; last_7d: number; last_30d: number; total: number };
  funnel_totals: {
    signed_up: number;
    profile_extracted: number;
    contract_uploaded: number;
    rfp_viewed: number;
    rfp_saved: number;
    rfp_applied: number;
    proposal_generated: number;
    poe_generated: number;
  };
  funnel_conversion_rates: {
    signup_to_profile: number;
    profile_to_view: number;
    view_to_save: number;
    save_to_apply: number;
    view_to_apply: number;
    apply_to_proposal: number;
  };
  retention: {
    cohorts: Record<
      string,
      { size: number; d1: number; d7: number; d30: number }
    >;
  };
  satisfaction: {
    proposals_generated: number;
    proposals_regenerated: number;
    proposal_acceptance_rate: number;
    poes_generated: number;
    poes_regenerated: number;
    poe_acceptance_rate: number;
    total_logins: number;
    total_rfps_viewed: number;
    total_rfps_saved: number;
    total_rfps_applied: number;
  };
  per_user: Array<{
    username: string;
    signup_at?: string;
    last_active_at?: string;
    cohort_week?: string;
    days_since_signup?: number;
    days_since_last_active?: number;
    counters: Record<string, number>;
    funnel: Record<string, string>;
  }>;
  /**
   * Per-counter distribution across users — lets the dashboard show the
   * spread (mean, median, p90, max) rather than just totals. Useful for
   * spotting whether one super-user is dragging the totals up.
   */
  user_distributions: Record<
    string,
    {
      users_with_value: number;
      total: number;
      mean: number;
      median: number;
      p90: number;
      max: number;
    }
  >;
  /**
   * Event-payload rollups for the last EVENT_WINDOW_DAYS days. These come
   * from scanning the byEventType GSI on civitas-kpi-events and are intended
   * to drive the dev /admin/kpis dashboard's drill-downs.
   */
  event_rollups: {
    window_days: number;
    event_counts: Record<string, number>;
    top_filter_values: Array<{ filterName: string; filterValues: string; count: number }>;
    filter_cleared_counts: Record<string, number>;
    top_search_lengths: Array<{ bucket: string; count: number }>;
    search_zero_result_rate: number;
    rfp_ctr: { impressions: number; views: number; ctr: number };
    rfp_section_expansions: Record<string, number>;
    rfp_attachment_clicks: number;
    rfp_external_link_clicks: number;
    rfp_dwell_ms_median: number | null;
    rfp_dwell_ms_p90: number | null;
    home_cta_distribution: Record<string, number>;
    home_widget_views: Record<string, number>;
    tracker_status_transitions: Record<string, number>;
    tracker_notes_added: number;
    tracker_notes_edited: number;
    onboarding_step_dwell_ms_median: Record<string, number>;
    onboarding_step_skip_rate: Record<string, number>;
    onboarding_validation_errors: Record<string, number>;
    sort_key_distribution: Record<string, number>;
    /**
     * Per-user page-view distribution, segmented by page category
     * (home / dashboard / matches / tracker / rfp_detail / profile / ...).
     * Each entry carries: how many distinct users have visited that page,
     * total events, mean/median/p90/max visits per user.
     */
    page_views_by_path: Record<
      string,
      {
        users_with_value: number;
        total: number;
        mean: number;
        median: number;
        p90: number;
        max: number;
      }
    >;
  };
}

async function scanAllUsers(
  testUsernames: ReadonlySet<string>,
): Promise<UserSummary[]> {
  const out: UserSummary[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await getDynamoClient().send(
      new ScanCommand({
        TableName: getKpiUsersTable(),
        Limit: 100,
        ExclusiveStartKey: lastKey,
      })
    );
    for (const item of resp.Items ?? []) {
      const funnel: Record<string, string> = {};
      const counters: Record<string, number> = {};
      for (const [k, v] of Object.entries(item)) {
        if (k.startsWith("funnel_") && typeof v === "string") funnel[k] = v;
        else if (k.startsWith("counter_") && typeof v === "number") counters[k] = v;
      }
      const username =
        typeof item.username === "string"
          ? item.username
          : typeof item.pk === "string"
            ? decodeURIComponent(item.pk.replace(/^USER#/, ""))
            : "";
      // Exclude test accounts from KPI rollups — events were still recorded
      // for them, but they'd bias DAU/MAU, funnel rates, and per-user spread
      // calculations. See lib/test-users.ts for the list.
      if (testUsernames.has(username.toLowerCase())) continue;
      out.push({
        username,
        signup_at: typeof item.signup_at === "string" ? item.signup_at : undefined,
        cohort_week: typeof item.cohort_week === "string" ? item.cohort_week : undefined,
        last_active_at:
          typeof item.last_active_at === "string" ? item.last_active_at : undefined,
        funnel,
        counters,
      });
    }
    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return out;
}

function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}

function aggregate(users: UserSummary[], now: Date): KpiSummary {
  const cutoff24h = now.getTime() - DAY_MS;
  const cutoff7d = now.getTime() - 7 * DAY_MS;
  const cutoff30d = now.getTime() - 30 * DAY_MS;

  let dau = 0,
    wau = 0,
    mau = 0;
  let signups24h = 0,
    signups7d = 0,
    signups30d = 0;

  const funnelTotals = {
    signed_up: 0,
    profile_extracted: 0,
    contract_uploaded: 0,
    rfp_viewed: 0,
    rfp_saved: 0,
    rfp_applied: 0,
    proposal_generated: 0,
    poe_generated: 0,
  };

  let totalProposalsGenerated = 0;
  let totalProposalsRegenerated = 0;
  let totalPoesGenerated = 0;
  let totalPoesRegenerated = 0;
  let totalLogins = 0;
  let totalRfpsViewed = 0;
  let totalRfpsSaved = 0;
  let totalRfpsApplied = 0;

  const cohorts: Record<
    string,
    { size: number; d1: number; d7: number; d30: number }
  > = {};

  const perUser: KpiSummary["per_user"] = [];

  for (const u of users) {
    const lastActiveTime = u.last_active_at ? new Date(u.last_active_at) : null;
    if (lastActiveTime) {
      const t = lastActiveTime.getTime();
      if (t >= cutoff24h) dau++;
      if (t >= cutoff7d) wau++;
      if (t >= cutoff30d) mau++;
    }

    const signupTime = u.signup_at ? new Date(u.signup_at) : null;
    if (signupTime) {
      const t = signupTime.getTime();
      if (t >= cutoff24h) signups24h++;
      if (t >= cutoff7d) signups7d++;
      if (t >= cutoff30d) signups30d++;
      funnelTotals.signed_up++;

      if (u.cohort_week) {
        const c =
          cohorts[u.cohort_week] ??
          (cohorts[u.cohort_week] = { size: 0, d1: 0, d7: 0, d30: 0 });
        c.size++;
        if (lastActiveTime) {
          // Proxy retention: activity span >= N days. Not strict cohort
          // retention (didn't return at exactly D7), but a useful first-pass
          // signal pre-launch. Replace with event-table queries when worth it.
          const span = lastActiveTime.getTime() - t;
          if (span >= DAY_MS) c.d1++;
          if (span >= 7 * DAY_MS) c.d7++;
          if (span >= 30 * DAY_MS) c.d30++;
        }
      }
    }

    if (u.funnel.funnel_profile_extracted_at) funnelTotals.profile_extracted++;
    if (u.funnel.funnel_first_contract_uploaded_at) funnelTotals.contract_uploaded++;
    if (u.funnel.funnel_first_rfp_view_at) funnelTotals.rfp_viewed++;
    if (u.funnel.funnel_first_save_at) funnelTotals.rfp_saved++;
    if (u.funnel.funnel_first_apply_at) funnelTotals.rfp_applied++;
    if (u.funnel.funnel_first_proposal_at) funnelTotals.proposal_generated++;
    if (u.funnel.funnel_first_poe_at) funnelTotals.poe_generated++;

    totalProposalsGenerated += u.counters.counter_proposals_generated ?? 0;
    totalProposalsRegenerated += u.counters.counter_proposals_regenerated ?? 0;
    totalPoesGenerated += u.counters.counter_poes_generated ?? 0;
    totalPoesRegenerated += u.counters.counter_poes_regenerated ?? 0;
    totalLogins += u.counters.counter_logins ?? 0;
    totalRfpsViewed += u.counters.counter_rfps_viewed ?? 0;
    totalRfpsSaved += u.counters.counter_rfps_saved ?? 0;
    totalRfpsApplied += u.counters.counter_rfps_applied ?? 0;

    perUser.push({
      username: u.username,
      signup_at: u.signup_at,
      last_active_at: u.last_active_at,
      cohort_week: u.cohort_week,
      days_since_signup: signupTime ? daysBetween(now, signupTime) : undefined,
      days_since_last_active: lastActiveTime
        ? daysBetween(now, lastActiveTime)
        : undefined,
      counters: u.counters,
      funnel: u.funnel,
    });
  }

  // Per-counter distribution. Walk every counter that's ever appeared on
  // any user (union of keys), collect non-zero values, compute summary
  // stats. Skipping zero-only counters keeps the dashboard list short.
  const allCounterKeys = new Set<string>();
  for (const u of users) for (const k of Object.keys(u.counters)) allCounterKeys.add(k);
  const userDistributions: KpiSummary["user_distributions"] = {};
  for (const key of allCounterKeys) {
    const values = users
      .map((u) => u.counters[key] ?? 0)
      .filter((v) => v > 0);
    if (values.length === 0) continue;
    const sum = values.reduce((a, b) => a + b, 0);
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianVal =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    const p90Idx = Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length));
    userDistributions[key] = {
      users_with_value: values.length,
      total: sum,
      mean: Math.round((sum / values.length) * 100) / 100,
      median: Math.round(medianVal * 100) / 100,
      p90: sorted[p90Idx],
      max: Math.max(...values),
    };
  }

  const proposalAcceptance =
    totalProposalsGenerated > 0
      ? Math.max(
          0,
          1 - totalProposalsRegenerated / totalProposalsGenerated
        )
      : 0;
  const poeAcceptance =
    totalPoesGenerated > 0
      ? Math.max(0, 1 - totalPoesRegenerated / totalPoesGenerated)
      : 0;

  return {
    computed_at: now.toISOString(),
    total_users: users.length,
    active_users: { DAU: dau, WAU: wau, MAU: mau },
    signups: {
      last_24h: signups24h,
      last_7d: signups7d,
      last_30d: signups30d,
      total: funnelTotals.signed_up,
    },
    funnel_totals: funnelTotals,
    funnel_conversion_rates: {
      signup_to_profile: pct(
        funnelTotals.profile_extracted,
        funnelTotals.signed_up
      ),
      profile_to_view: pct(
        funnelTotals.rfp_viewed,
        funnelTotals.profile_extracted
      ),
      view_to_save: pct(funnelTotals.rfp_saved, funnelTotals.rfp_viewed),
      save_to_apply: pct(funnelTotals.rfp_applied, funnelTotals.rfp_saved),
      view_to_apply: pct(funnelTotals.rfp_applied, funnelTotals.rfp_viewed),
      apply_to_proposal: pct(
        funnelTotals.proposal_generated,
        funnelTotals.rfp_applied
      ),
    },
    retention: { cohorts },
    satisfaction: {
      proposals_generated: totalProposalsGenerated,
      proposals_regenerated: totalProposalsRegenerated,
      proposal_acceptance_rate: Math.round(proposalAcceptance * 10_000) / 100,
      poes_generated: totalPoesGenerated,
      poes_regenerated: totalPoesRegenerated,
      poe_acceptance_rate: Math.round(poeAcceptance * 10_000) / 100,
      total_logins: totalLogins,
      total_rfps_viewed: totalRfpsViewed,
      total_rfps_saved: totalRfpsSaved,
      total_rfps_applied: totalRfpsApplied,
    },
    per_user: perUser,
    user_distributions: userDistributions,
    // Filled in by computeAndStoreKpiSummary — aggregate() is sync and the
    // rollup pass is async. We seed an empty shape here so the type stays
    // honest and consumers that read aggregate() directly (none today) still
    // get a valid object.
    event_rollups: {
      window_days: EVENT_WINDOW_DAYS,
      event_counts: {},
      top_filter_values: [],
      filter_cleared_counts: {},
      top_search_lengths: [],
      search_zero_result_rate: 0,
      rfp_ctr: { impressions: 0, views: 0, ctr: 0 },
      rfp_section_expansions: {},
      rfp_attachment_clicks: 0,
      rfp_external_link_clicks: 0,
      rfp_dwell_ms_median: null,
      rfp_dwell_ms_p90: null,
      home_cta_distribution: {},
      home_widget_views: {},
      tracker_status_transitions: {},
      tracker_notes_added: 0,
      tracker_notes_edited: 0,
      onboarding_step_dwell_ms_median: {},
      onboarding_step_skip_rate: {},
      onboarding_validation_errors: {},
      sort_key_distribution: {},
      page_views_by_path: {},
    },
  };
}

interface RawEvent {
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
  username?: string;
}

/**
 * Query the byEventType GSI for a single event type, paginated until we hit
 * the time window cutoff or the result cap. Returns events newest-first
 * (Query against gsi1sk = "{ts}#{user}#{id}" sorts lexicographically).
 */
async function queryEventsByType(
  type: string,
  cutoffIso: string,
  limit = 5000,
): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await getDynamoClient().send(
      new QueryCommand({
        TableName: getKpiEventsTable(),
        IndexName: "byEventType",
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk >= :sk",
        ExpressionAttributeValues: {
          ":pk": `TYPE#${type}`,
          ":sk": cutoffIso,
        },
        Limit: 500,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of resp.Items ?? []) {
      const ev: RawEvent = {
        type: typeof item.type === "string" ? item.type : type,
        timestamp: typeof item.timestamp === "string" ? item.timestamp : "",
        payload:
          item.payload && typeof item.payload === "object"
            ? (item.payload as Record<string, unknown>)
            : {},
        username: typeof item.username === "string" ? item.username : undefined,
      };
      out.push(ev);
      if (out.length >= limit) break;
    }
    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (out.length >= limit) break;
  } while (lastKey);
  return out;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

function percentile(nums: number[], p: number): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

function topN<T extends Record<string, number>>(
  counts: T,
  n: number,
): Array<{ key: string; count: number }> {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

async function buildEventRollups(
  now: Date,
  testUsernames: ReadonlySet<string>,
): Promise<KpiSummary["event_rollups"]> {
  const cutoff = new Date(now.getTime() - EVENT_WINDOW_DAYS * DAY_MS).toISOString();
  // One Query per event type, in parallel. Each is GSI-keyed + time-bounded so
  // they stay cheap even as the event log grows.
  const allowSettled = await Promise.allSettled(
    ROLLUP_EVENT_TYPES.map((t) => queryEventsByType(t, cutoff).then((evs) => [t, evs] as const)),
  );
  const eventsByType: Record<string, RawEvent[]> = {};
  for (const r of allowSettled) {
    if (r.status === "fulfilled") {
      const [t, evs] = r.value;
      // Drop events authored by test accounts so rollups (CTR, dwell,
      // filter values, etc.) reflect real users only. See lib/test-users.ts.
      eventsByType[t] = evs.filter(
        (ev) => !ev.username || !testUsernames.has(ev.username.toLowerCase()),
      );
    } else {
      console.warn("[kpi-aggregator] event rollup query failed:", r.reason);
    }
  }

  const event_counts: Record<string, number> = {};
  for (const [t, evs] of Object.entries(eventsByType)) event_counts[t] = evs.length;

  // Filter values — count by (filterName, filterValues) combo.
  const filterValueCounts: Record<string, number> = {};
  const filterClearedCounts: Record<string, number> = {};
  for (const ev of eventsByType["filter_applied"] ?? []) {
    const fn = String(ev.payload.filterName ?? "unknown");
    const fv = String(ev.payload.filterValues ?? "");
    const key = `${fn}::${fv}`;
    filterValueCounts[key] = (filterValueCounts[key] ?? 0) + 1;
  }
  const top_filter_values = topN(filterValueCounts, 20).map(({ key, count }) => {
    const sep = key.indexOf("::");
    return {
      filterName: key.slice(0, sep),
      filterValues: key.slice(sep + 2),
      count,
    };
  });
  for (const ev of eventsByType["filter_cleared"] ?? []) {
    const fn = String(ev.payload.filterName ?? "unknown");
    filterClearedCounts[fn] = (filterClearedCounts[fn] ?? 0) + 1;
  }

  // Search behavior.
  const searchLengthBuckets: Record<string, number> = {
    "1-3": 0,
    "4-10": 0,
    "11-20": 0,
    "21+": 0,
  };
  for (const ev of eventsByType["search_submitted"] ?? []) {
    const ql = Number(ev.payload.queryLength ?? 0);
    if (ql <= 3) searchLengthBuckets["1-3"]++;
    else if (ql <= 10) searchLengthBuckets["4-10"]++;
    else if (ql <= 20) searchLengthBuckets["11-20"]++;
    else searchLengthBuckets["21+"]++;
  }
  const top_search_lengths = Object.entries(searchLengthBuckets).map(
    ([bucket, count]) => ({ bucket, count }),
  );
  let zeroResults = 0;
  let resultCountFires = 0;
  for (const ev of eventsByType["search_result_count"] ?? []) {
    resultCountFires++;
    if (ev.payload.zeroResults === true) zeroResults++;
  }
  const search_zero_result_rate =
    resultCountFires > 0 ? Math.round((zeroResults / resultCountFires) * 10000) / 100 : 0;

  // RFP CTR + section expansions + dwell.
  const impressions = (eventsByType["rfp_impression"] ?? []).length;
  const views = (eventsByType["rfp_viewed"] ?? []).length;
  const rfp_ctr = {
    impressions,
    views,
    ctr: impressions > 0 ? Math.round((views / impressions) * 10000) / 100 : 0,
  };
  const rfp_section_expansions: Record<string, number> = {};
  for (const ev of eventsByType["rfp_section_expanded"] ?? []) {
    const section = String(ev.payload.section ?? "unknown");
    rfp_section_expansions[section] = (rfp_section_expansions[section] ?? 0) + 1;
  }
  const dwellMs: number[] = [];
  for (const ev of eventsByType["rfp_dwell"] ?? []) {
    const ms = Number(ev.payload.durationMs ?? 0);
    if (ms > 0) dwellMs.push(ms);
  }
  const rfp_dwell_ms_median = median(dwellMs);
  const rfp_dwell_ms_p90 = percentile(dwellMs, 90);

  // Homepage.
  const home_cta_distribution: Record<string, number> = {};
  for (const ev of eventsByType["home_cta_clicked"] ?? []) {
    const k = String(ev.payload.ctaKey ?? "unknown");
    home_cta_distribution[k] = (home_cta_distribution[k] ?? 0) + 1;
  }
  const home_widget_views: Record<string, number> = {};
  for (const ev of eventsByType["home_widget_viewed"] ?? []) {
    const k = String(ev.payload.widgetKey ?? "unknown");
    home_widget_views[k] = (home_widget_views[k] ?? 0) + 1;
  }

  // Tracker.
  const tracker_status_transitions: Record<string, number> = {};
  for (const ev of eventsByType["tracker_status_changed_from_tracker"] ?? []) {
    const from = String(ev.payload.from ?? "?");
    const to = String(ev.payload.to ?? "?");
    const key = `${from}→${to}`;
    tracker_status_transitions[key] = (tracker_status_transitions[key] ?? 0) + 1;
  }

  // Onboarding.
  const dwellByStep: Record<string, number[]> = {};
  for (const ev of eventsByType["onboarding_step_dwell"] ?? []) {
    const step = String(ev.payload.stepName ?? `step_${ev.payload.step ?? "?"}`);
    const ms = Number(ev.payload.durationMs ?? 0);
    if (ms > 0) (dwellByStep[step] ??= []).push(ms);
  }
  const onboarding_step_dwell_ms_median: Record<string, number> = {};
  for (const [step, arr] of Object.entries(dwellByStep)) {
    const m = median(arr);
    if (m != null) onboarding_step_dwell_ms_median[step] = m;
  }
  const viewsByStep: Record<string, number> = {};
  const skipsByStep: Record<string, number> = {};
  for (const ev of eventsByType["onboarding_step_viewed"] ?? []) {
    const step = String(ev.payload.stepName ?? `step_${ev.payload.step ?? "?"}`);
    viewsByStep[step] = (viewsByStep[step] ?? 0) + 1;
  }
  for (const ev of eventsByType["onboarding_step_skipped"] ?? []) {
    const step = String(ev.payload.stepName ?? `step_${ev.payload.step ?? "?"}`);
    skipsByStep[step] = (skipsByStep[step] ?? 0) + 1;
  }
  const onboarding_step_skip_rate: Record<string, number> = {};
  for (const step of Object.keys(viewsByStep)) {
    const v = viewsByStep[step];
    const s = skipsByStep[step] ?? 0;
    onboarding_step_skip_rate[step] = v > 0 ? Math.round((s / v) * 10000) / 100 : 0;
  }
  const onboarding_validation_errors: Record<string, number> = {};
  for (const ev of eventsByType["onboarding_validation_error"] ?? []) {
    const step = String(ev.payload.stepName ?? "?");
    const field = String(ev.payload.field ?? "?");
    const key = `${step}::${field}`;
    onboarding_validation_errors[key] = (onboarding_validation_errors[key] ?? 0) + 1;
  }

  // Sort.
  const sort_key_distribution: Record<string, number> = {};
  for (const ev of eventsByType["sort_changed"] ?? []) {
    const k = `${String(ev.payload.sortKey ?? "?")}/${String(ev.payload.direction ?? "?")}`;
    sort_key_distribution[k] = (sort_key_distribution[k] ?? 0) + 1;
  }

  // Page views, segmented by page category and grouped by user. The summary
  // counter_page_views totals every path; this rollup splits it so the
  // dashboard can show "median tracker visits per user", "median homepage
  // visits per user", etc. Per-user counts let us compute spread (mean,
  // median, p90, max) the same way we do for any other counter.
  const pageViewsByUserAndPath: Record<string, Map<string, number>> = {};
  for (const ev of eventsByType["page_viewed"] ?? []) {
    if (!ev.username) continue;
    const cat = pageCategory(typeof ev.payload.pagePath === "string" ? ev.payload.pagePath : "");
    const userMap = (pageViewsByUserAndPath[cat] ??= new Map());
    userMap.set(ev.username, (userMap.get(ev.username) ?? 0) + 1);
  }
  const page_views_by_path: KpiSummary["event_rollups"]["page_views_by_path"] = {};
  for (const [cat, userMap] of Object.entries(pageViewsByUserAndPath)) {
    const values = Array.from(userMap.values()).filter((v) => v > 0);
    if (values.length === 0) continue;
    const sum = values.reduce((a, b) => a + b, 0);
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const p90Idx = Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length));
    page_views_by_path[cat] = {
      users_with_value: values.length,
      total: sum,
      mean: Math.round((sum / values.length) * 100) / 100,
      median: Math.round(med * 100) / 100,
      p90: sorted[p90Idx],
      max: Math.max(...values),
    };
  }

  return {
    window_days: EVENT_WINDOW_DAYS,
    event_counts,
    top_filter_values,
    filter_cleared_counts: filterClearedCounts,
    top_search_lengths,
    search_zero_result_rate,
    rfp_ctr,
    rfp_section_expansions,
    rfp_attachment_clicks: (eventsByType["rfp_attachment_clicked"] ?? []).length,
    rfp_external_link_clicks: (eventsByType["rfp_external_link_clicked"] ?? []).length,
    rfp_dwell_ms_median,
    rfp_dwell_ms_p90,
    home_cta_distribution,
    home_widget_views,
    tracker_status_transitions,
    tracker_notes_added: (eventsByType["tracker_note_added"] ?? []).length,
    tracker_notes_edited: (eventsByType["tracker_note_edited"] ?? []).length,
    onboarding_step_dwell_ms_median,
    onboarding_step_skip_rate,
    onboarding_validation_errors,
    sort_key_distribution,
    page_views_by_path,
  };
}

function dailyKey(now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `metrics/aggregate/daily/${yyyy}-${mm}-${dd}.json`;
}

const LATEST_KEY = "metrics/aggregate/latest.json";

/**
 * Compute the KPI summary and store it to S3.
 * Writes both a dated daily snapshot and the canonical "latest.json".
 */
export async function computeAndStoreKpiSummary(): Promise<KpiSummary> {
  const now = new Date();
  // Resolve test users once; both the per-user scan and the event-rollup
  // pass need the same set so the snapshot stays internally consistent.
  const testUsernames = await resolveTestUsernames();
  const [users, rollups] = await Promise.all([
    scanAllUsers(testUsernames),
    buildEventRollups(now, testUsernames).catch((err) => {
      // Rollups failing shouldn't break the per-user summary — log and emit
      // an empty rollup so the rest of the snapshot still lands.
      console.warn("[kpi-aggregator] event rollups failed:", err);
      return null;
    }),
  ]);
  const summary = aggregate(users, now);
  if (rollups) summary.event_rollups = rollups;
  await Promise.all([
    putObjectJSON(dailyKey(now), summary),
    putObjectJSON(LATEST_KEY, summary),
  ]);
  return summary;
}
