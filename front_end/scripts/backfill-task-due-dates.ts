// One-off backfill: fill in NULL due_dates on already-seeded rfp_tasks
// rows from rfp_cache.key_dates.
//
// Why this exists: seedDefaultTasks() became date-aware in PR #71. Any RFP
// saved BEFORE that code shipped (or saved during the brief Vercel deploy
// window when the previous build was still serving) has tasks with
// due_date = NULL. seedDefaultTasks is idempotent so it won't re-seed those.
//
// Safe to re-run. Only updates:
//   - is_custom = false (seeded tasks; user-created tasks have is_custom=true)
//   - due_date IS NULL (never overwrites a value the user set or that we
//     previously populated)
//   - completed_at IS NULL (don't touch already-completed tasks)
//
// Maps task label → rfp_cache date column:
//   "Submit questions by Q&A deadline"  → qa_deadline
//   "Attend pre-bid meeting"            → prebid_meeting_at, falling back to site_visit_at
//   "Submit bid by deadline"            → deadline

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env.local"), override: true });

import postgres from "postgres";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1,
    ssl: process.env.DATABASE_URL!.includes(".rds.amazonaws.com") ? "require" as const : undefined,
  });

  // Three independent updates, one per label/date pair. SQL is simple enough
  // that we don't need a generic dispatch — explicit is fine.
  const updates = [
    {
      label: "Submit questions by Q&A deadline",
      // qa_deadline is timestamptz → cast to date for the rfp_tasks.due_date column
      dateExpr: sql`(rc.qa_deadline AT TIME ZONE 'UTC')::date`,
    },
    {
      label: "Attend pre-bid meeting",
      dateExpr: sql`COALESCE((rc.prebid_meeting_at AT TIME ZONE 'UTC')::date, (rc.site_visit_at AT TIME ZONE 'UTC')::date)`,
    },
    {
      label: "Submit bid by deadline",
      dateExpr: sql`(rc.deadline AT TIME ZONE 'UTC')::date`,
    },
  ];

  let total = 0;
  for (const u of updates) {
    if (dryRun) {
      const preview = await sql`
        SELECT t.id, t.user_id, t.rfp_id, t.label, ${u.dateExpr} AS new_due_date
        FROM rfp_tasks t
        JOIN rfp_cache rc ON rc.id = t.rfp_id
        WHERE t.is_custom = false
          AND t.due_date IS NULL
          AND t.completed_at IS NULL
          AND t.label = ${u.label}
          AND ${u.dateExpr} IS NOT NULL
        LIMIT 5
      `;
      console.log(`[dry-run] ${u.label}: ${preview.length === 5 ? "≥5" : preview.length} rows to update (showing first 5):`);
      for (const r of preview) {
        console.log("  ", r.rfp_id, "→", r.new_due_date);
      }
    } else {
      const result = await sql`
        UPDATE rfp_tasks t
        SET due_date = ${u.dateExpr}
        FROM rfp_cache rc
        WHERE rc.id = t.rfp_id
          AND t.is_custom = false
          AND t.due_date IS NULL
          AND t.completed_at IS NULL
          AND t.label = ${u.label}
          AND ${u.dateExpr} IS NOT NULL
      `;
      const count = result.count ?? 0;
      console.log(`[backfill-task-due-dates] ${u.label}: updated ${count} rows`);
      total += count;
    }
  }

  if (!dryRun) {
    console.log(`[backfill-task-due-dates] done. total updated: ${total}`);
  }

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
