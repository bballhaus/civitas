// CLI wrapper for the NAICS tagger. The real work lives in
// src/lib/rfp-tagger.ts so the same logic can run inline from the
// sync-rfp-cache cron after each scrape batch.
//
// Targeting: defaults to rows with no naics_codes OR no scope_summary.
//   FORCE=1 retags everything (use when prompt changes meaningfully).
//   LIMIT=N caps the number of rows processed (testing).
//
// Usage: npm run rfp:tag-naics

import "dotenv/config";
import { tagAllRfps } from "../src/lib/rfp-tagger";

async function main() {
  const force = process.env.FORCE === "1";
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
  const result = await tagAllRfps({ force, limit, log: true });
  const elapsed = (result.elapsedMs / 1000).toFixed(1);
  console.log(
    `[tag] done in ${elapsed}s — ${result.tagged} tagged (${result.lowConfidence} low-confidence)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[tag] failed:", err);
    process.exit(1);
  });
