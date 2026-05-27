/**
 * Allowlist of test accounts whose activity should be excluded from KPI
 * rollups. Two parallel lists:
 *
 *   TEST_USERS_RAW   — usernames (the field every event carries)
 *   TEST_EMAILS_RAW  — emails (looked up in Postgres at aggregation time)
 *
 * The aggregator resolves these into a single "effective test usernames"
 * set (see kpi-aggregator.ts → resolveTestUsernames), so adding an entry
 * to either list has the same effect.
 *
 * Filtering happens read-side: events are still recorded to DynamoDB, so
 * this is reversible — remove an entry and the next refresh re-includes
 * the user. The daily snapshot files written before any edit still hold
 * the old totals (they're append-only historical records), so kicking a
 * fresh refresh is the way to retro-correct.
 *
 * Both lists are case-insensitive.
 */

const TEST_USERS_RAW: string[] = [
  "brooke",
  "sierrawest",
  "sierraw",
  "testuser",
  "sierra",
  "tester",
  "newsierra",
  "civtest",
  "bbbbb",
  "newaCC",
  "SierraWestInc",
  "sw",
  "ssssss",
];

const TEST_EMAILS_RAW: string[] = [
  "brookeballhaus@me.com",
  "brookeballhaus@gmail.com",
  "brooke@civitas-ai.net",
  "civitas@civitas-ai.net",
  "ballhaus@stanford.edu",
  "gretzky@stanford.edu",
];

export const TEST_USERS: ReadonlySet<string> = new Set(
  TEST_USERS_RAW.map((u) => u.toLowerCase()),
);

export const TEST_EMAILS: ReadonlySet<string> = new Set(
  TEST_EMAILS_RAW.map((e) => e.toLowerCase()),
);

export function isTestUsername(username: string | null | undefined): boolean {
  if (!username) return false;
  return TEST_USERS.has(username.toLowerCase());
}

export function isTestEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return TEST_EMAILS.has(email.toLowerCase());
}

/**
 * Back-compat alias — older call sites that only had a username.
 */
export function isTestUser(username: string | null | undefined): boolean {
  return isTestUsername(username);
}
