/**
 * Allowlist of usernames whose activity should be excluded from KPI rollups.
 *
 * Filtering happens in the aggregator (lib/kpi-aggregator.ts) — events are
 * still recorded to DynamoDB, so this is reversible / toggleable. The user
 * summary and event rollups exclude these usernames; the time-series view
 * picks them up automatically from the next daily snapshot.
 *
 * Usernames are case-insensitive. Add an entry whenever you create a test
 * account (smoke tests, demo recordings, etc.) so it doesn't bias DAU/MAU,
 * funnel rates, or per-user distributions.
 *
 * If you need to filter someone retroactively, run a one-off refresh after
 * editing this list — the daily snapshot files written before then still
 * contain the old totals (they're append-only historical records).
 */

const TEST_USERS_RAW: string[] = [
  "brooke",
  "sierrawest",
  "sierraw",
  "testuser",
];

export const TEST_USERS: ReadonlySet<string> = new Set(
  TEST_USERS_RAW.map((u) => u.toLowerCase()),
);

export function isTestUser(username: string | null | undefined): boolean {
  if (!username) return false;
  return TEST_USERS.has(username.toLowerCase());
}
