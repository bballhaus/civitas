// Apply the Sonnet RFP-tag critique to the database.
//
// For each critique row:
//   - If Sonnet agreed: leave Haiku's tag (no DB write)
//   - If Sonnet disagreed: overwrite naics_codes with [suggested_primary, ...suggested_secondary]
//
// scope_summary is NOT touched — that field is Haiku's narrative output and
// Sonnet wasn't asked to rewrite it. If Sonnet's primary disagrees, the
// summary may now slightly mismatch the tags, but the matcher only reads
// codes; the summary is for display/embedding context.
//
// Usage: npm run rfp:apply-tag-critique

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { rfpCache } from "../src/db/schema";

const CRITIQUE_IN = "scripts/.cache/rfp-tag-critique.json";

interface CritiqueResult {
  id: string;
  original_primary: string;
  original_secondary: string[];
  agree: boolean;
  suggested_primary: string;
  suggested_secondary: string[];
  concern: string;
}

async function main() {
  if (!existsSync(CRITIQUE_IN)) {
    console.error(`Missing ${CRITIQUE_IN}. Run npm run rfp:critique-tags first.`);
    process.exit(1);
  }
  const critiques = (JSON.parse(readFileSync(CRITIQUE_IN, "utf8")).critiques ?? []) as CritiqueResult[];
  const disagreed = critiques.filter((c) => !c.agree);
  console.log(`[apply-tag-critique] ${critiques.length} audited, ${disagreed.length} corrections to apply`);

  let written = 0;
  for (const c of disagreed) {
    const newCodes = [c.suggested_primary, ...c.suggested_secondary];
    await db.update(rfpCache).set({ naicsCodes: newCodes }).where(eq(rfpCache.id, c.id));
    written += 1;
  }
  console.log(`[apply-tag-critique] wrote ${written} corrections to rfp_cache`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[apply-tag-critique] failed:", err);
    process.exit(1);
  });
