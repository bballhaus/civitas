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
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoClient, getKpiUsersTable } from "./dynamodb";
import { putObjectJSON } from "./s3";

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
}

async function scanAllUsers(): Promise<UserSummary[]> {
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
  const users = await scanAllUsers();
  const summary = aggregate(users, now);
  await Promise.all([
    putObjectJSON(dailyKey(now), summary),
    putObjectJSON(LATEST_KEY, summary),
  ]);
  return summary;
}
