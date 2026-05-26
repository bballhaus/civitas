// Stage 4 — apply the Sonnet critique to the Haiku draft to produce the
// final NAICS substitutes matrix.
//
// For each directional substitute entry:
//   - If Sonnet agreed (or never audited): keep the Haiku weight.
//   - If Sonnet disagreed and suggested a non-zero weight: use it.
//   - If Sonnet disagreed and suggested zero: REMOVE the entry.
//
// Output: front_end/src/data/naics-substitutes.json
//   { code → [{ code, weight, rationale }, ...] }   // directed adjacency
//
// This is the file the matcher reads at runtime. Committed to the repo so
// it's bundled with deployments.
//
// Usage: npm run naics:apply-critique

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

const DRAFT_IN = "scripts/naics-substitutes/.cache/naics-substitutes-draft.json";
const CRITIQUE_IN = "scripts/naics-substitutes/.cache/naics-critique.json";
const FINAL_OUT = "src/data/naics-substitutes.json";

interface DraftEntry {
  code: string;
  weight: number;
  rationale: string;
}
type Draft = Record<string, DraftEntry[]>;

interface Critique {
  src: string;
  dst: string;
  original_weight: number;
  original_rationale: string;
  agree: boolean;
  suggested_weight: number;
  concern: string;
}

function main() {
  if (!existsSync(DRAFT_IN)) {
    console.error(`Missing ${DRAFT_IN}. Run npm run naics:judge-candidates first.`);
    process.exit(1);
  }
  if (!existsSync(CRITIQUE_IN)) {
    console.error(`Missing ${CRITIQUE_IN}. Run npm run naics:critique first.`);
    process.exit(1);
  }

  const draft = JSON.parse(readFileSync(DRAFT_IN, "utf8")) as Draft;
  const critique = JSON.parse(readFileSync(CRITIQUE_IN, "utf8")).critiques as Critique[];

  // Index critique by (src, dst) so we can look up per entry.
  const verdict = new Map<string, Critique>();
  for (const c of critique) verdict.set(`${c.src}|${c.dst}`, c);

  let kept = 0;
  let updated = 0;
  let dropped = 0;
  let unaudited = 0;
  const final: Draft = {};

  for (const src of Object.keys(draft)) {
    for (const entry of draft[src]) {
      const c = verdict.get(`${src}|${entry.code}`);
      if (!c) {
        // Not audited — keep as-is.
        unaudited += 1;
        if (!final[src]) final[src] = [];
        final[src].push(entry);
        continue;
      }
      if (c.agree) {
        kept += 1;
        if (!final[src]) final[src] = [];
        final[src].push(entry);
        continue;
      }
      // Disagreed.
      if (c.suggested_weight <= 0) {
        dropped += 1;
        continue;
      }
      updated += 1;
      if (!final[src]) final[src] = [];
      // Replace weight + tag rationale with the Sonnet concern so the
      // explainability output downstream shows the corrected reasoning.
      final[src].push({
        code: entry.code,
        weight: c.suggested_weight,
        rationale: c.concern || entry.rationale,
      });
    }
  }

  // Stable ordering inside each source's list — high weight first.
  for (const src of Object.keys(final)) {
    final[src].sort((a, b) => b.weight - a.weight);
  }

  const totalFinal = Object.values(final).reduce((n, arr) => n + arr.length, 0);
  const stats = {
    generated_at: new Date().toISOString(),
    source_codes: Object.keys(final).length,
    total_entries: totalFinal,
    haiku_kept: kept,
    sonnet_corrected_weight: updated,
    sonnet_dropped: dropped,
    unaudited_kept: unaudited,
  };

  // Output format: stats at top for human reference, matrix as `matrix` field.
  writeFileSync(
    FINAL_OUT,
    JSON.stringify({ stats, matrix: final }, null, 2),
  );

  console.log(`[apply] wrote ${FINAL_OUT}`);
  console.log(`[apply] source codes:           ${stats.source_codes}`);
  console.log(`[apply] total directional pairs: ${stats.total_entries}`);
  console.log(`[apply]   Haiku agreed:          ${stats.haiku_kept}`);
  console.log(`[apply]   Sonnet corrected:      ${stats.sonnet_corrected_weight}`);
  console.log(`[apply]   Sonnet dropped:        ${stats.sonnet_dropped}`);
  console.log(`[apply]   unaudited (kept):      ${stats.unaudited_kept}`);
}

main();
