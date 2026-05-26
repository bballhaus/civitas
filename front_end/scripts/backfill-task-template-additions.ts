// One-off backfill: for every existing (user, RFP) in the tracker, insert
// any default-template entries that don't yet exist for that RFP. Picks up
// new labels added to DEFAULT_TASK_TEMPLATE after the RFP was first saved.
//
// Pre-existing user-customized rows are left alone (we match by label).
// Sort order for new rows: appended at the end of the existing list so we
// don't disturb any manual reordering.
//
// Re-runnable: rows that already exist are skipped.
//
// Usage:
//   npx tsx scripts/backfill-task-template-additions.ts          # apply
//   npx tsx scripts/backfill-task-template-additions.ts --dry-run

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env.local"), override: true });

import postgres from "postgres";

const dryRun = process.argv.slice(2).includes("--dry-run");

// Kept in sync with src/db/queries/rfp-tasks.ts DEFAULT_TASK_TEMPLATE.
// Each row knows which rfp_cache column (if any) seeds its due_date.
type DateColumn =
  | "deadline"
  | "qa_deadline"
  | "qa_response_date"
  | "prebid_meeting_at"
  | "site_visit_at"
  | "award_date"
  | "contract_start"
  | "contract_end";

const TEMPLATE: ReadonlyArray<{ label: string; dateCol?: DateColumn }> = [
  { label: "Review RFP and attachments" },
  { label: "Confirm bid / no-bid decision" },
  { label: "Submit questions by Q&A deadline", dateCol: "qa_deadline" },
  { label: "Q&A answers posted", dateCol: "qa_response_date" },
  { label: "Attend pre-bid meeting", dateCol: "prebid_meeting_at" },
  { label: "Site visit", dateCol: "site_visit_at" },
  { label: "Draft proposal" },
  { label: "Internal review" },
  { label: "Submit bid by deadline", dateCol: "deadline" },
  { label: "Award decision", dateCol: "award_date" },
  { label: "Contract starts", dateCol: "contract_start" },
  { label: "Contract ends", dateCol: "contract_end" },
];

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1,
    ssl: process.env.DATABASE_URL!.includes(".rds.amazonaws.com") ? "require" as const : undefined,
  });

  // Every (user, rfp) pair that's currently in the tracker.
  const trackedPairs = await sql<Array<{ user_id: string; rfp_id: string }>>`
    SELECT DISTINCT user_id, rfp_id
    FROM match_state
    WHERE status IS NOT NULL
  `;
  console.log(`[backfill] ${trackedPairs.length} (user, rfp) pairs in tracker`);

  let inserted = 0;
  let skipped = 0;

  for (const pair of trackedPairs) {
    // Existing task labels for this pair — anything in this set is left untouched.
    const existing = await sql<Array<{ label: string; sort_order: number }>>`
      SELECT label, sort_order
      FROM rfp_tasks
      WHERE user_id = ${pair.user_id} AND rfp_id = ${pair.rfp_id}
    `;
    if (existing.length === 0) {
      // No tasks at all → first save will hit seedDefaultTasks, which already
      // covers the new labels. Skip; don't impersonate that path here.
      skipped += 1;
      continue;
    }
    const existingLabels = new Set(existing.map((r) => r.label));
    const missing = TEMPLATE.filter((t) => !existingLabels.has(t.label));
    if (missing.length === 0) continue;

    // Look up rfp_cache row for the date columns we need
    const [cache] = await sql<Array<{
      deadline: Date | null;
      qa_deadline: Date | null;
      qa_response_date: string | null;
      prebid_meeting_at: Date | null;
      site_visit_at: Date | null;
      award_date: string | null;
      contract_start: string | null;
      contract_end: string | null;
    }>>`
      SELECT deadline, qa_deadline, qa_response_date,
             prebid_meeting_at, site_visit_at, award_date,
             contract_start, contract_end
      FROM rfp_cache
      WHERE id = ${pair.rfp_id}
    `;
    const dateFor = (col?: DateColumn): string | null => {
      if (!col || !cache) return null;
      const v = (cache as unknown as Record<string, unknown>)[col];
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    };

    // Start appending from one past the current max sort_order so we don't
    // disturb any reordering the user did.
    let nextOrder = Math.max(...existing.map((r) => r.sort_order)) + 1;

    const rows = missing.map((t) => ({
      user_id: pair.user_id,
      rfp_id: pair.rfp_id,
      label: t.label,
      due_date: dateFor(t.dateCol),
      sort_order: nextOrder++,
      is_custom: false,
    }));

    if (dryRun) {
      console.log(`[dry-run] would insert ${rows.length} rows for ${pair.rfp_id}:`);
      for (const r of rows) {
        console.log(`  +  ${r.label.padEnd(40)} due=${r.due_date ?? "<none>"}`);
      }
    } else {
      for (const r of rows) {
        await sql`
          INSERT INTO rfp_tasks (user_id, rfp_id, label, due_date, sort_order, is_custom)
          VALUES (${r.user_id}, ${r.rfp_id}, ${r.label}, ${r.due_date},
                  ${r.sort_order}, ${r.is_custom})
        `;
      }
    }
    inserted += rows.length;
  }

  console.log(
    `[backfill] done. ${dryRun ? "would-insert" : "inserted"}=${inserted} skipped_pairs=${skipped}`,
  );
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
