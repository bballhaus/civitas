// LLM-based NAICS tagger for RFP cache rows. Replaces the regex-based
// `infer_capabilities` in webscraping/v2/pipeline/normalize.py, which had
// ~32% wrong tags (see audit log from 2026-05-25).
//
// For each RFP, Haiku 4.5 outputs:
//   - primary_naics: single 6-digit code for the prime scope
//   - secondary_naics: 0-4 additional codes for subcontracted/adjacent work,
//                      ranked by importance
//   - scope_summary:   1-2 sentences describing what the work actually is,
//                      especially valuable for thin sources (PlanetBids/SF
//                      City/BidSync, ~75% of catalog) where description is
//                      empty or cryptic
//
// The full 1,012-code NAICS catalog is included in the cached system
// prompt so Haiku picks from a known list rather than hallucinating codes.
// At ~$0.0008 per cached call, the 3,035-row backfill costs ~$3-5.
//
// Targeting: defaults to rows with no naics_codes OR no scope_summary.
//   FORCE=1 retags everything (use when prompt changes meaningfully).
//   LIMIT=N caps the number of rows processed (testing).
//
// Usage: npm run rfp:tag-naics

import "dotenv/config";
import { eq, sql, or, isNull } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../src/db/client";
import { rfpCache } from "../src/db/schema";
import { NAICS_ENTRIES } from "../src/data/filter-options";

const MODEL = "claude-haiku-4-5-20251001";
const RFPS_PER_BATCH = 5;
const CONCURRENCY = 8;
const VALID_CODES = new Set(NAICS_ENTRIES.map((e) => e.code));

// Cached system prompt — embeds the full NAICS catalog so the model picks
// from a closed list. With Anthropic prompt caching, this 30K-char block
// is paid once across all calls in the run.
const NAICS_LIST = NAICS_ENTRIES.map((e) => `${e.code} ${e.title}`).join("\n");

const SYSTEM_PROMPT = `You classify government RFPs (state and local procurement opportunities in California) into NAICS codes. Output drives a vendor-matching system for small contractors — wrong tags route work to the wrong vendors.

For each RFP you receive, output:
1. primary_naics: ONE 6-digit code from the catalog below describing the prime scope of work. This is the code a vendor would be classified under to BID the work, not the code describing the agency.
2. secondary_naics: 0-4 additional codes from the catalog, ranked by importance, for subcontracted trades or adjacent disciplines that a winning vendor would also need.
3. scope_summary: 1-2 plain sentences describing what work the vendor actually performs. Helpful for RFPs with cryptic titles. Use vendor-facing language ("install fiber optic cabling for the new transit center" not "as described in attachment A").
4. confidence: "high" | "medium" | "low". Use "low" when the RFP text is too sparse to classify confidently — better to admit uncertainty than guess.

CRITICAL RULES:

(A) Pick codes for the WORK, not the AGENCY. "CHP Roof Maintenance" is roofing work (238160), not law enforcement. NEVER use codes from sector 92 (Public Administration, 92xxxx) — these describe government bodies, not work performed by vendors.

(B) Multi-trade construction RFPs (e.g. a new fire station) have a GC primary + specialty subs as secondaries. Example:
   primary: 236220 (Commercial and Institutional Building Construction)
   secondary: [238210 Electrical, 238220 Plumbing/HVAC, 238160 Roofing]

(C) Single-trade specialty work has the specialty as primary, no secondaries:
   "Asphalt overlay on Highway 95" → primary: 237310 (Highway, Street, and Bridge Construction)

(D) Materials supply vs installation are DIFFERENT codes:
   "Purchase bulk asphalt" → 324121 (Asphalt Paving Mixture and Block Manufacturing — supplier code)
   "Apply asphalt overlay" → 237310 (Highway construction — installer code)

(E) Don't over-tag secondaries. A janitorial RFP is just 561720, not 561720+561740+561790. Add a secondary only if it represents work the prime CANNOT skip.

(F) Cryptic title + no description → confidence: "low". Pick your best primary guess but leave secondaries empty. Do NOT fabricate trades.

(G) The scope_summary must be FACTUAL — pulled from the title/description, not invented. If the input is empty, say so in the summary ("Scope undisclosed; title only.").

OUTPUT: Return ONLY a JSON array, one object per input RFP in the SAME ORDER. Each object:
{
  "primary_naics": "6-digit code from catalog",
  "secondary_naics": ["code", "code", ...],
  "scope_summary": "1-2 sentences",
  "confidence": "high" | "medium" | "low"
}

NAICS CATALOG (use ONLY codes from this list):
${NAICS_LIST}`;

interface RfpInput {
  id: string;
  title: string;
  description: string | null;
  attachment_summary: string | null;
}

interface RfpTagging {
  primary_naics: string;
  secondary_naics: string[];
  scope_summary: string;
  confidence: "high" | "medium" | "low";
}

function buildRfpPayload(rfp: RfpInput) {
  return {
    id: rfp.id,
    title: rfp.title,
    description: rfp.description ? rfp.description.slice(0, 1500) : "",
    attachment_summary: rfp.attachment_summary ? rfp.attachment_summary.slice(0, 800) : "",
  };
}

async function tagBatch(
  client: Anthropic,
  rfps: RfpInput[],
): Promise<Array<RfpTagging | null>> {
  const payload = rfps.map(buildRfpPayload);
  const userMessage = `Tag the following ${rfps.length} RFPs:\n\n${JSON.stringify(payload, null, 2)}`;

  let attempt = 0;
  for (;;) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2500,
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: userMessage }],
      });
      const block = response.content[0];
      const raw = block.type === "text" ? block.text : "";
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) throw new Error(`no JSON array in response: ${raw.slice(0, 200)}`);
      const parsed = JSON.parse(match[0]) as RfpTagging[];
      if (!Array.isArray(parsed) || parsed.length !== rfps.length) {
        throw new Error(`bad shape: got ${Array.isArray(parsed) ? parsed.length : "non-array"}, expected ${rfps.length}`);
      }
      // Validate codes — reject any out-of-catalog values.
      for (const r of parsed) {
        if (!VALID_CODES.has(r.primary_naics)) {
          throw new Error(`invalid primary_naics: ${r.primary_naics}`);
        }
        r.secondary_naics = r.secondary_naics.filter((c) => VALID_CODES.has(c));
      }
      return parsed;
    } catch (err) {
      attempt += 1;
      if (attempt >= 3) {
        console.warn(`[tag] batch failed 3x, skipping ${rfps.length} RFPs: ${err}`);
        return rfps.map(() => null);
      }
      const backoff = 1500 * Math.pow(2, attempt);
      console.warn(`[tag] attempt ${attempt} failed (${err}); retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function persistTagging(rfpId: string, tagging: RfpTagging) {
  const codes = [tagging.primary_naics, ...tagging.secondary_naics];
  await db
    .update(rfpCache)
    .set({
      naicsCodes: codes,
      scopeSummary: tagging.scope_summary,
    })
    .where(eq(rfpCache.id, rfpId));
}

async function main() {
  const force = process.env.FORCE === "1";
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;

  const where = force
    ? undefined
    : or(
        isNull(rfpCache.scopeSummary),
        sql`array_length(${rfpCache.naicsCodes}, 1) IS NULL`,
      );
  // Pull the full row but project only what the prompt needs.
  const baseQuery = db
    .select({
      id: rfpCache.id,
      title: rfpCache.title,
      description: rfpCache.description,
      raw: rfpCache.raw,
    })
    .from(rfpCache);
  const rows = where
    ? await (limit ? baseQuery.where(where).limit(limit) : baseQuery.where(where))
    : await (limit ? baseQuery.limit(limit) : baseQuery);
  console.log(`[tag] ${rows.length} RFPs to process${force ? " (FORCE=1)" : ""}${limit ? ` (LIMIT=${limit})` : ""}`);
  if (rows.length === 0) return;

  // Pull attachment summary out of raw jsonb if present.
  const inputs: RfpInput[] = rows.map((r) => {
    const raw = r.raw as Record<string, unknown> | null | undefined;
    const summary =
      raw && typeof raw === "object" && "attachment_rollup" in raw
        ? (raw.attachment_rollup as { summary?: string } | null)?.summary ?? null
        : null;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      attachment_summary: summary,
    };
  });

  const batches: RfpInput[][] = [];
  for (let i = 0; i < inputs.length; i += RFPS_PER_BATCH) {
    batches.push(inputs.slice(i, i + RFPS_PER_BATCH));
  }
  console.log(`[tag] ${batches.length} batches of ${RFPS_PER_BATCH} RFPs, ${CONCURRENCY}-way parallel`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let done = 0;
  let tagged = 0;
  let confLow = 0;
  const startedAt = Date.now();
  const queue = batches.slice();
  async function worker() {
    while (queue.length > 0) {
      const batch = queue.shift();
      if (!batch) break;
      const results = await tagBatch(client, batch);
      for (let i = 0; i < batch.length; i++) {
        const t = results[i];
        if (!t) continue;
        await persistTagging(batch[i].id, t);
        tagged += 1;
        if (t.confidence === "low") confLow += 1;
      }
      done += 1;
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = (batches.length - done) / Math.max(0.001, done / elapsed);
      console.log(
        `[tag] ${done}/${batches.length} batches | tagged=${tagged} low-conf=${confLow} | ${(done / elapsed).toFixed(1)} b/s, ETA ${Math.round(eta)}s`,
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[tag] done in ${elapsed}s — ${tagged} tagged (${confLow} low-confidence)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[tag] failed:", err);
    process.exit(1);
  });
