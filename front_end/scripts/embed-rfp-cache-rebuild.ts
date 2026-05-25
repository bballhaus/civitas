// One-off: re-embed EVERY rfp_cache row, even ones that already have a
// vector. Run after changing buildRfpEmbeddingText so existing rows pick up
// the new format (e.g. when NAICS titles were folded into the embedding
// text on 2026-05-25).
//
// Don't wire this into cron — a full rebuild burns through the Voyage
// quota. The default rfp-cache:embed loop only touches rows where
// embedding IS NULL, which is what cron should keep doing.
//
// Usage: npm run rfp-cache:embed-rebuild

import "dotenv/config";
import { refreshRfpEmbeddings } from "../src/lib/embeddings";

async function main() {
  let total = 0;
  for (;;) {
    const n = await refreshRfpEmbeddings(500, { force: true });
    total += n;
    console.log(`[rebuild] processed ${n} rows (running total: ${total})`);
    if (n < 500) break;
  }
  console.log(`[rebuild] done; ${total} rows re-embedded`);
}

main().catch((err) => {
  console.error("[rebuild] failed:", err);
  process.exit(1);
});
