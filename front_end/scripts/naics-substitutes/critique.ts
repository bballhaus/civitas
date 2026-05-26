// Stage 3 — Sonnet 4.6 critiques the Haiku judgments from Stage 2.
//
// Construction-subset run (294 pairs) found Haiku is wrong 71% of the time
// there, with systematic patterns (specialty→GC overweighting, contractor↔
// manufacturer confusion). The full matrix is very likely to have the same
// blind spots, so we critique everything before applying corrections.
//
// Resume: pairs already in CRITIQUE_OUT are skipped, so this script can be
// re-run safely after interruption or to top up new pairs.
//
// Scope env var (defaults to "all"):
//   SCOPE=all          → critique every YES judgment (default)
//   SCOPE=construction → only pairs where either side is in NAICS sector 23
//   SCOPE=cross-sector → only pairs where src and dst differ in first 2 digits
//                        (the highest-risk subset for Haiku's systematic errors)
//
// Output: scripts/naics-substitutes/.cache/naics-critique.json
//   { critiques: [{ src, dst, original_weight, agree, suggested_weight,
//                   concern }] }
//
// Usage: npm run naics:critique  (optionally SCOPE=cross-sector)

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { NAICS_ENTRIES } from "../../src/data/filter-options";

const DRAFT_IN = "scripts/naics-substitutes/.cache/naics-substitutes-draft.json";
const CRITIQUE_OUT = "scripts/naics-substitutes/.cache/naics-critique.json";

const MODEL = "claude-sonnet-4-6";
const PAIRS_PER_BATCH = 20;
const CONCURRENCY = 6;
const SCOPE = (process.env.SCOPE ?? "all") as "all" | "construction" | "cross-sector";

const TITLE_BY_CODE: Record<string, string> = Object.fromEntries(
  NAICS_ENTRIES.map((e) => [e.code, e.title]),
);

interface DraftEntry {
  code: string;
  weight: number;
  rationale: string;
}
type Draft = Record<string, DraftEntry[]>;

interface DirectedPair {
  src: string;
  dst: string;
  original_weight: number;
  original_rationale: string;
}

interface Critique extends DirectedPair {
  agree: boolean;
  suggested_weight: number;
  concern: string;
}

const SYSTEM_PROMPT = `You audit substitute-vendor judgments for a government procurement matching system. Another evaluator produced a directional weight for each (vendor NAICS, RFP NAICS) pair indicating how well a vendor classified under the vendor code can bid work classified under the RFP code. You critique each judgment for real-world correctness.

Be a STERN reviewer. The other evaluator (Haiku) makes systematic errors you should watch for:

1. DIRECTION ASYMMETRY VIOLATIONS — the biggest false-positive source.
   A specialty contractor cannot prime a general contractor's work. The reverse is often fine.
   - 238xxx (specialty trade) → 236xxx (general contractor / building construction): NOT substitutable, weight should be 0.0-0.2.
   - 236xxx → 238xxx (GC can sub out specialty work): typically 0.5-0.7.
   - 541xxx (single discipline) → 236xxx (full construction project): typically 0.0-0.2.
   - This pattern repeats across many sector pairs.

2. CONTRACTOR ↔ MANUFACTURER CONFUSION.
   Installing or specifying a product is not the same as manufacturing it.
   - 238210 (Electrical Contractor) → 335931 (Wiring Device Manufacturing): NOT substitutable.
   - 236xxx (GC) → 327xxx (concrete materials manufacturing): NOT substitutable.
   - 236xxx (GC) → 321992 (Prefab housing manufacturing): NOT substitutable.

3. PROFESSIONAL CREDENTIAL GAPS.
   - 236xxx (GC) → 541350 (Building Inspector): NOT substitutable — inspector requires separate credentials.
   - 238xxx → 541xxx engineering or architecture: NOT substitutable unless credentials overlap.

4. SAME-WORD-DIFFERENT-TRADE TRAPS in construction.
   - 238110 (Poured Concrete) vs 238160 (Roofing): different CSLB classes (C-8 vs C-39).
   - 238210 (Electrical) vs 238220 (Plumbing/HVAC): different licenses (C-10 vs C-36).
   - 335210 (Small Appliance Mfg) vs 335220 (Major Appliance Mfg): different plants, can't retool.

SUBSTITUTES THAT ARE REAL:
   - 236115 (Single-Family) ↔ 236116 (Multifamily): same residential trade, weight ~0.85.
   - 238120 (Structural Steel) ↔ 238130 (Framing): both structural, weight ~0.5-0.7.
   - 541511 (Custom Programming) ↔ 541512 (Systems Design): same talent pool, weight ~0.9.
   - 541611 (Admin Mgmt Consulting) ↔ 541618 (Other Mgmt Consulting): basically same business, weight ~0.85.
   - 561720 (Janitorial) ↔ 561740 (Carpet Cleaning): different specialty same buyer/crew, weight ~0.7.
   - 238210 (Electrical) → 561621 (Security Systems): clear low-voltage overlap, weight ~0.6.

For each pair you'll get the original weight (0-1) and rationale. Decide:
- agree (bool): does the original weight reflect real-world substitutability (±0.15 tolerance)?
- suggested_weight (0-1): if you disagree, what's the right weight? If you agree, return the original.
- concern (string, under 20 words): why you flagged this, or empty string if you agree.

OUTPUT: Return ONLY a JSON array, one object per input judgment in the SAME ORDER. Each object: {"agree": boolean, "suggested_weight": number, "concern": string}`;

function loadPairsToAudit(): DirectedPair[] {
  const draft = JSON.parse(readFileSync(DRAFT_IN, "utf8")) as Draft;
  const filter = (src: string, dst: string): boolean => {
    if (SCOPE === "construction") {
      return src.startsWith("23") || dst.startsWith("23");
    }
    if (SCOPE === "cross-sector") {
      return src.slice(0, 2) !== dst.slice(0, 2);
    }
    return true;
  };
  const out: DirectedPair[] = [];
  for (const src of Object.keys(draft)) {
    for (const entry of draft[src]) {
      if (entry.weight > 0 && filter(src, entry.code)) {
        out.push({
          src,
          dst: entry.code,
          original_weight: entry.weight,
          original_rationale: entry.rationale,
        });
      }
    }
  }
  return out;
}

function loadExistingCritiques(): Critique[] {
  if (!existsSync(CRITIQUE_OUT)) return [];
  return (JSON.parse(readFileSync(CRITIQUE_OUT, "utf8")).critiques ?? []) as Critique[];
}

function saveCritiques(all: Critique[]) {
  // Sort: disagreements first, biggest disagreements first.
  const sorted = all.slice().sort((a, b) => {
    if (a.agree !== b.agree) return a.agree ? 1 : -1;
    return Math.abs(b.suggested_weight - b.original_weight) - Math.abs(a.suggested_weight - a.original_weight);
  });
  writeFileSync(
    CRITIQUE_OUT,
    JSON.stringify({ generated_at: new Date().toISOString(), critiques: sorted }, null, 2),
  );
}

async function critiqueBatch(
  client: Anthropic,
  items: DirectedPair[],
): Promise<Array<{ agree: boolean; suggested_weight: number; concern: string } | null>> {
  const payload = items.map((it, i) => ({
    i,
    vendor_code: it.src,
    vendor_title: TITLE_BY_CODE[it.src],
    rfp_code: it.dst,
    rfp_title: TITLE_BY_CODE[it.dst],
    original_weight: it.original_weight,
    original_rationale: it.original_rationale,
  }));
  const userMessage = `Critique these ${items.length} directional substitute judgments:\n\n${JSON.stringify(payload, null, 2)}`;

  let attempt = 0;
  for (;;) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: userMessage }],
      });
      const block = response.content[0];
      const raw = block.type === "text" ? block.text : "";
      // Sonnet often leads with "I'll analyze these pairs..." or wraps in
      // ``` fences. Extract the first balanced JSON array from the response.
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) throw new Error(`no JSON array found in response: ${raw.slice(0, 200)}`);
      const parsed = JSON.parse(match[0]) as Array<{
        agree: boolean;
        suggested_weight: number;
        concern: string;
      }>;
      if (!Array.isArray(parsed) || parsed.length !== items.length) {
        throw new Error(`bad shape: got ${Array.isArray(parsed) ? parsed.length : "non-array"}, expected ${items.length}`);
      }
      return parsed;
    } catch (err) {
      attempt += 1;
      if (attempt >= 3) {
        console.warn(`[critique] batch failed 3x, skipping ${items.length} items: ${err}`);
        return items.map(() => null);
      }
      const backoff = 1500 * Math.pow(2, attempt);
      console.warn(`[critique] attempt ${attempt} failed (${err}); retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function main() {
  if (!existsSync(DRAFT_IN)) {
    console.error(`Missing ${DRAFT_IN}. Run npm run naics:judge-candidates first.`);
    process.exit(1);
  }
  const allPairs = loadPairsToAudit();
  const existing = loadExistingCritiques();
  const existingKey = new Set(existing.map((c) => `${c.src}|${c.dst}`));
  const todo = allPairs.filter((p) => !existingKey.has(`${p.src}|${p.dst}`));

  console.log(`[critique] scope=${SCOPE}, ${allPairs.length} pairs in scope, ${existing.length} already audited, ${todo.length} to do`);
  if (todo.length === 0) {
    console.log(`[critique] nothing to do`);
    return;
  }

  const batches: DirectedPair[][] = [];
  for (let i = 0; i < todo.length; i += PAIRS_PER_BATCH) {
    batches.push(todo.slice(i, i + PAIRS_PER_BATCH));
  }
  console.log(`[critique] ${batches.length} batches at ${PAIRS_PER_BATCH} per batch, ${CONCURRENCY}-way parallel`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const newCritiques: Critique[] = [];
  let done = 0;
  let saveCounter = 0;
  const startedAt = Date.now();
  const queue = batches.slice();
  async function worker() {
    while (queue.length > 0) {
      const batch = queue.shift();
      if (!batch) break;
      const results = await critiqueBatch(client, batch);
      for (let i = 0; i < batch.length; i++) {
        const r = results[i];
        if (!r) continue;
        newCritiques.push({
          ...batch[i],
          agree: r.agree,
          suggested_weight: Math.max(0, Math.min(1, r.suggested_weight)),
          concern: r.concern,
        });
      }
      done += 1;
      saveCounter += 1;
      if (saveCounter >= 10) {
        saveCritiques([...existing, ...newCritiques]);
        saveCounter = 0;
      }
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = (batches.length - done) / Math.max(0.001, done / elapsed);
      console.log(`[critique] ${done}/${batches.length} batches (${(done / elapsed).toFixed(1)} b/s, ETA ${Math.round(eta)}s)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  saveCritiques([...existing, ...newCritiques]);
  const all = [...existing, ...newCritiques];
  const disagreed = all.filter((c) => !c.agree);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[critique] done in ${elapsed}s — ${newCritiques.length} new, ${all.length} total, ${disagreed.length} flagged (${((disagreed.length / all.length) * 100).toFixed(0)}%)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[critique] failed:", err);
    process.exit(1);
  });
