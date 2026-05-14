// One-off: backfill embeddings for every rfp_cache row missing one.
// Run after `npm run rfp-cache:populate` and any time new rows land.
//
// Usage: npm run rfp-cache:embed

import "dotenv/config";
import { refreshRfpEmbeddings } from "../src/lib/embeddings";

async function main() {
  let total = 0;
  // Loop until the helper reports zero remaining; lets us page through
  // very large catalogs without blowing batch limits.
  for (;;) {
    const n = await refreshRfpEmbeddings(500);
    total += n;
    console.log(`[embed] processed ${n} rows (running total: ${total})`);
    if (n === 0) break;
  }
  console.log(`[embed] done; ${total} rows embedded`);
}

main().catch((err) => {
  console.error("[embed] failed:", err);
  process.exit(1);
});
