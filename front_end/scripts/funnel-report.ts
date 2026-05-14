/**
 * Funnel report — human-readable view of signup + onboarding KPIs.
 *
 * Usage:
 *   npx tsx scripts/funnel-report.ts              # all users
 *   npx tsx scripts/funnel-report.ts sierra       # one user
 *
 * Reads the two KPI tables (civitas-kpi-users for summaries, civitas-kpi-events
 * via the byEventType GSI for per-stage breakdowns) and prints a four-section
 * report to stdout:
 *   1. Signup funnel  — form → email sent → email clicked → account → onboard
 *   2. Per-user time-to-verify (verification_sent → verification_clicked)
 *   3. Per-stage onboarding counts — views/advances/skips/backs by step 1-9
 *   4. Stage drop-off ranked from worst to best
 */
import { ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoClient, getKpiEventsTable, getKpiUsersTable } from "../src/lib/dynamodb";
import { TOTAL_STEPS, STEP_META } from "../src/lib/onboarding-data";

const SIGNUP_FUNNEL_STAGES = [
  { event: "signup_form_submitted", checkpoint: "funnel_signup_form_submitted_at", label: "Form submitted" },
  { event: "signup_verification_sent", checkpoint: "funnel_signup_verification_sent_at", label: "Email sent" },
  { event: "signup_verification_clicked", checkpoint: "funnel_signup_verification_clicked_at", label: "Email clicked" },
  { event: "signup", checkpoint: "funnel_signup_at", label: "Account created" },
  { event: "onboarding_step_viewed", checkpoint: "funnel_onboarding_started_at", label: "Onboarding started" },
  { event: "onboarding_completed", checkpoint: "funnel_onboarded_at", label: "Onboarding completed" },
] as const;

const STAGE_EVENTS = [
  "onboarding_step_viewed",
  "onboarding_step_advanced",
  "onboarding_step_skipped",
  "onboarding_step_back",
] as const;

interface UserRow {
  username: string;
  funnel: Record<string, string>;
  counters: Record<string, number>;
}

async function scanUsers(filterUsername?: string): Promise<UserRow[]> {
  const out: UserRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await getDynamoClient().send(
      new ScanCommand({
        TableName: getKpiUsersTable(),
        Limit: 100,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of resp.Items ?? []) {
      const username = typeof item.username === "string" ? item.username : "";
      if (!username) continue;
      if (filterUsername && username !== filterUsername) continue;
      const funnel: Record<string, string> = {};
      const counters: Record<string, number> = {};
      for (const [k, v] of Object.entries(item)) {
        if (k.startsWith("funnel_") && typeof v === "string") funnel[k] = v;
        else if (k.startsWith("counter_") && typeof v === "number") counters[k] = v;
      }
      out.push({ username, funnel, counters });
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

interface StageEvent {
  username: string;
  step: number;
  timestamp: string;
}

async function queryStageEvents(
  eventType: (typeof STAGE_EVENTS)[number],
  filterUsername?: string,
): Promise<StageEvent[]> {
  const out: StageEvent[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await getDynamoClient().send(
      new QueryCommand({
        TableName: getKpiEventsTable(),
        IndexName: "byEventType",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `TYPE#${eventType}` },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of resp.Items ?? []) {
      const username = typeof item.username === "string" ? item.username : "";
      if (filterUsername && username !== filterUsername) continue;
      const payload = (item.payload as { step?: unknown } | undefined) ?? {};
      const step = typeof payload.step === "number" ? payload.step : NaN;
      if (!Number.isFinite(step)) continue;
      const timestamp = typeof item.timestamp === "string" ? item.timestamp : "";
      out.push({ username, step, timestamp });
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function durationMin(start: string, end: string): string {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

async function main() {
  const filterUsername = process.argv[2];
  if (filterUsername) {
    console.log(`\n=== Funnel report for user: ${filterUsername} ===\n`);
  } else {
    console.log(`\n=== Funnel report (all users) ===\n`);
  }

  const users = await scanUsers(filterUsername);
  if (users.length === 0) {
    console.log("No users found." + (filterUsername ? ` Username '${filterUsername}' not in summary table.` : ""));
    return;
  }

  // 1. Signup funnel — count users who reached each checkpoint.
  console.log("─── 1. Signup funnel (cumulative) ───");
  console.log(pad("Stage", 30) + pad("Users", 10) + pad("vs prev", 12) + "vs top");
  const counts = SIGNUP_FUNNEL_STAGES.map((s) => users.filter((u) => u.funnel[s.checkpoint]).length);
  const top = counts[0] || 0;
  for (let i = 0; i < SIGNUP_FUNNEL_STAGES.length; i++) {
    const stage = SIGNUP_FUNNEL_STAGES[i];
    const cur = counts[i];
    const prev = i === 0 ? cur : counts[i - 1];
    console.log(
      pad(stage.label, 30) + pad(String(cur), 10) + pad(pct(cur, prev), 12) + pct(cur, top),
    );
  }

  // 2. Per-user time-to-verify (only for users with both timestamps).
  console.log("\n─── 2. Time to click verification email ───");
  const withTimes = users
    .filter((u) => u.funnel.funnel_signup_verification_sent_at && u.funnel.funnel_signup_verification_clicked_at)
    .map((u) => ({
      username: u.username,
      d: durationMin(u.funnel.funnel_signup_verification_sent_at, u.funnel.funnel_signup_verification_clicked_at),
      ms: Date.parse(u.funnel.funnel_signup_verification_clicked_at) - Date.parse(u.funnel.funnel_signup_verification_sent_at),
    }))
    .filter((x) => Number.isFinite(x.ms) && x.ms >= 0);
  if (withTimes.length === 0) {
    console.log("(no users have both timestamps yet)");
  } else {
    console.log(pad("Username", 25) + "Time to click");
    for (const w of withTimes.sort((a, b) => a.ms - b.ms)) {
      console.log(pad(w.username, 25) + w.d);
    }
    const median = withTimes.sort((a, b) => a.ms - b.ms)[Math.floor(withTimes.length / 2)];
    console.log(`\nMedian: ${median.d} (n=${withTimes.length})`);
  }

  // 3. Per-stage onboarding actions — by step number.
  console.log("\n─── 3. Per-stage onboarding actions ───");
  const stageEventsByType: Record<string, StageEvent[]> = {};
  for (const t of STAGE_EVENTS) {
    stageEventsByType[t] = await queryStageEvents(t, filterUsername);
  }

  console.log(
    pad("Step", 6) + pad("Name", 18) + pad("Views", 8) + pad("Adv", 8) + pad("Skip", 8) + pad("Back", 8) + "Adv%",
  );
  const dropOff: Array<{ step: number; name: string; views: number; advanceRate: number }> = [];
  for (let n = 1; n <= TOTAL_STEPS; n++) {
    const name = STEP_META[n - 1]?.short ?? `step_${n}`;
    const v = stageEventsByType.onboarding_step_viewed.filter((e) => e.step === n).length;
    const a = stageEventsByType.onboarding_step_advanced.filter((e) => e.step === n).length;
    const s = stageEventsByType.onboarding_step_skipped.filter((e) => e.step === n).length;
    const b = stageEventsByType.onboarding_step_back.filter((e) => e.step === n).length;
    console.log(
      pad(String(n), 6) +
        pad(name, 18) +
        pad(String(v), 8) +
        pad(String(a), 8) +
        pad(String(s), 8) +
        pad(String(b), 8) +
        pct(a, v),
    );
    dropOff.push({ step: n, name, views: v, advanceRate: v > 0 ? a / v : NaN });
  }

  // 4. Stages ranked by drop-off (lowest advance rate first).
  console.log("\n─── 4. Stages ranked by drop-off (lowest advance rate first) ───");
  const ranked = dropOff
    .filter((d) => d.views > 0)
    .sort((a, b) => a.advanceRate - b.advanceRate);
  if (ranked.length === 0) {
    console.log("(no stage views recorded yet)");
  } else {
    console.log(pad("Rank", 6) + pad("Step", 6) + pad("Name", 18) + pad("Views", 8) + "Advance %");
    ranked.forEach((d, i) => {
      console.log(
        pad(String(i + 1), 6) +
          pad(String(d.step), 6) +
          pad(d.name, 18) +
          pad(String(d.views), 8) +
          (Number.isFinite(d.advanceRate) ? (d.advanceRate * 100).toFixed(1) + "%" : "—"),
      );
    });
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
