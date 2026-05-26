// Stage 2 of the NAICS substitutes matrix build.
//
// For each candidate pair (a, b) from Stage 1, judge both directions:
//   - Can a vendor classified at A reasonably bid work classified at B?
//   - Can a vendor classified at B reasonably bid work classified at A?
//
// Directional because substitutability isn't symmetric: a GC at 236220
// can sub out plumbing work at 238220; a plumber at 238220 can't prime a
// GC contract at 236220.
//
// Batched 25 pairs (= 50 judgments) per Haiku call with prompt caching on
// the system block — keeps wall-clock low and cost negligible. The system
// prompt embeds concrete examples covering the failure modes we observed
// in scripts/test-naics-similarity.ts (concrete-vs-roofing, etc.) so the
// model doesn't repeat the embedding-test mistakes.
//
// Output: scripts/naics-substitutes/.cache/naics-substitutes-draft.json
//   { code → [{ code, weight, rationale }, ...] }   // directed adjacency
//
// Resume: if the draft already exists, pairs whose BOTH directions are
// already present are skipped. Safe to interrupt and re-run.
//
// Usage: npm run naics:judge-candidates

import "dotenv/config";
import { writeFileSync, readFileSync, existsSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { NAICS_ENTRIES } from "../../src/data/filter-options";

const CANDIDATES_IN = "scripts/naics-substitutes/.cache/naics-candidates.json";
const DRAFT_OUT = "scripts/naics-substitutes/.cache/naics-substitutes-draft.json";

const MODEL = "claude-haiku-4-5-20251001";
const PAIRS_PER_BATCH = 25;
const CONCURRENCY = 10;

const TITLE_BY_CODE: Record<string, string> = Object.fromEntries(
  NAICS_ENTRIES.map((e) => [e.code, e.title]),
);

interface CandidatePair {
  a: string;
  b: string;
}

interface Judgment {
  code: string;
  weight: number;
  rationale: string;
}

// Directed adjacency: source code → list of (target code + weight + rationale).
// Only entries with weight > 0 are stored (skipping the LLM's "not substitutable"
// verdicts to keep the file small).
type DraftMatrix = Record<string, Judgment[]>;

interface CandidatesFile {
  pairs: CandidatePair[];
}

const SYSTEM_PROMPT = `You evaluate whether a government vendor classified under one NAICS code can reasonably bid work classified under another NAICS code.

Your output drives a procurement matching system for small contractors. False positives (saying YES when work is incompatible) hurt vendors by surfacing irrelevant RFPs. False negatives (saying NO when there's a real fit) hurt vendors by hiding viable RFPs. Be honest about both.

CRITICAL RULES:

1. NAICS hierarchy does NOT imply substitutability. Sibling codes are often totally different trades.
   - 238110 (Poured Concrete Foundation) ↔ 238160 (Roofing Contractors): NOT substitutable. Both 2381 siblings but different CSLB classes (C-8 vs C-39), different equipment, different crews.
   - 238210 (Electrical Contractors) ↔ 238220 (Plumbing/HVAC): NOT substitutable. Different licenses (C-10 vs C-36).
   - 335210 (Small Appliance Mfg) ↔ 335220 (Major Appliance Mfg): NOT substitutable. Capital-intensive plants can't retool.
   - 236115 (Single-Family Housing) ↔ 236220 (Commercial Building): NOT substitutable. Different bonding, supervision, prevailing wage exposure.

2. Substitutability is DIRECTED. Some judgments are asymmetric:
   - A general contractor (e.g. 236220) can often bid plumbing work (238220) by subcontracting. Vendor=236220 → RFP=238220 may be PARTIAL.
   - A specialty plumber (238220) cannot prime a commercial-building GC contract (236220). Vendor=238220 → RFP=236220 is NOT substitutable.
   - Each direction is evaluated independently.

3. Genuine substitutes do exist. Examples:
   - 541511 (Custom Programming) ↔ 541512 (Computer Systems Design): SUBSTITUTABLE both ways, weight ~0.9. Same talent pool.
   - 541611 ↔ 541618 (Administrative vs Other Management Consulting): SUBSTITUTABLE both ways, weight ~0.9.
   - 236115 ↔ 236116 (Single-Family vs Multifamily Housing): SUBSTITUTABLE both ways, weight ~0.85. Same residential trade.
   - 561720 (Janitorial) ↔ 561740 (Carpet Cleaning): SUBSTITUTABLE both ways, weight ~0.7. Different specialties but same buyer and crew.

4. Cross-sector substitutability is real. Don't dismiss pairs just because they don't share sector digits:
   - 238210 (Electrical Contractors) → 561621 (Security Systems): vendor can often install security wiring. Weight ~0.6.
   - 238990 (Other Specialty Trade) → 332323 (Architectural Metal): a fence-install contractor may be classified either way. Weight ~0.7.

WEIGHT SEMANTICS (0.0 to 1.0):
- 1.0: identical work (don't return this — exact-code match is already handled separately)
- 0.85-0.95: very close substitute, work is essentially the same
- 0.65-0.85: clear substitute, overlapping skills but some adaptation
- 0.45-0.65: partial substitute, vendor can credibly bid but it's a stretch
- 0.25-0.45: marginal — only if vendor has broad capabilities or subcontracts
- 0.0-0.25: NOT substitutable (use substitutable=false instead)

When uncertain, prefer LOWER weights and substitutable=false. We can always loosen later; we can't easily detect false positives in production.

OUTPUT: Return ONLY a JSON array, no preamble, no markdown, no commentary. One object per input judgment in the SAME ORDER. Each object:
{
  "substitutable": boolean,
  "weight": number (0.0 to 1.0, must be 0 when substitutable=false),
  "rationale": string (under 15 words, explain WHY)
}`;

function loadDraft(): DraftMatrix {
  if (!existsSync(DRAFT_OUT)) return {};
  return JSON.parse(readFileSync(DRAFT_OUT, "utf8")) as DraftMatrix;
}

function saveDraft(draft: DraftMatrix) {
  writeFileSync(DRAFT_OUT, JSON.stringify(draft, null, 2));
}

function hasDirection(draft: DraftMatrix, src: string, dst: string): boolean {
  return (draft[src] ?? []).some((j) => j.code === dst);
}

function recordResult(
  draft: DraftMatrix,
  src: string,
  dst: string,
  substitutable: boolean,
  weight: number,
  rationale: string,
) {
  if (!substitutable || weight <= 0) return; // skip non-substitutes
  if (!draft[src]) draft[src] = [];
  // Replace if already present (re-judge); else append.
  const existing = draft[src].findIndex((j) => j.code === dst);
  const entry = { code: dst, weight: Math.max(0, Math.min(1, weight)), rationale };
  if (existing >= 0) draft[src][existing] = entry;
  else draft[src].push(entry);
}

interface BatchItem {
  src: string;
  dst: string;
}

async function judgeBatch(
  client: Anthropic,
  items: BatchItem[],
): Promise<Array<{ substitutable: boolean; weight: number; rationale: string } | null>> {
  const userPayload = items.map((it, i) => ({
    i,
    vendor_code: it.src,
    vendor_title: TITLE_BY_CODE[it.src],
    rfp_code: it.dst,
    rfp_title: TITLE_BY_CODE[it.dst],
  }));

  const userMessage = `Judge the following ${items.length} (vendor → rfp) directional pairs. For each, can a vendor classified under vendor_code reasonably bid the work classified under rfp_code?\n\n${JSON.stringify(userPayload, null, 2)}`;

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
      // Strip any accidental code-fence wrapping.
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(cleaned) as Array<{
        substitutable: boolean;
        weight: number;
        rationale: string;
      }>;
      if (!Array.isArray(parsed) || parsed.length !== items.length) {
        throw new Error(`bad shape: got ${Array.isArray(parsed) ? parsed.length : "non-array"}, expected ${items.length}`);
      }
      return parsed;
    } catch (err) {
      attempt += 1;
      if (attempt >= 3) {
        console.warn(`[judge] batch failed 3x, skipping ${items.length} items: ${err}`);
        return items.map(() => null);
      }
      const backoff = 1000 * Math.pow(2, attempt);
      console.warn(`[judge] attempt ${attempt} failed (${err}); retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function main() {
  if (!existsSync(CANDIDATES_IN)) {
    console.error(`Missing ${CANDIDATES_IN}. Run npm run naics:generate-candidates first.`);
    process.exit(1);
  }
  const { pairs } = JSON.parse(readFileSync(CANDIDATES_IN, "utf8")) as CandidatesFile;
  console.log(`[judge] loaded ${pairs.length} candidate pairs`);

  // Expand into directed items, then drop ones already in the draft.
  const draft = loadDraft();
  const existingCount = Object.values(draft).reduce((n, arr) => n + arr.length, 0);
  if (existingCount > 0) {
    console.log(`[judge] resuming — draft already has ${existingCount} substitute entries`);
  }
  const todo: BatchItem[] = [];
  for (const { a, b } of pairs) {
    if (!hasDirection(draft, a, b)) todo.push({ src: a, dst: b });
    if (!hasDirection(draft, b, a)) todo.push({ src: b, dst: a });
  }
  // Note: hasDirection only checks substitutes that resolved to YES. A
  // previously-judged "not substitutable" is NOT recorded, so it would
  // be re-judged on resume. That's acceptable cost; the alternative is
  // a separate "judged-but-rejected" set.
  console.log(`[judge] ${todo.length} directional judgments to make`);
  if (todo.length === 0) {
    console.log(`[judge] nothing to do`);
    return;
  }

  // Chunk into batches.
  const batches: BatchItem[][] = [];
  for (let i = 0; i < todo.length; i += PAIRS_PER_BATCH) {
    batches.push(todo.slice(i, i + PAIRS_PER_BATCH));
  }
  console.log(`[judge] ${batches.length} batches at ${PAIRS_PER_BATCH} judgments each, ${CONCURRENCY}-way parallel`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let done = 0;
  let added = 0;
  let saveCounter = 0;
  const startedAt = Date.now();

  // Simple bounded-concurrency worker loop.
  const queue = batches.slice();
  async function worker() {
    while (queue.length > 0) {
      const batch = queue.shift();
      if (!batch) break;
      const results = await judgeBatch(client, batch);
      for (let i = 0; i < batch.length; i++) {
        const r = results[i];
        if (!r) continue;
        recordResult(draft, batch[i].src, batch[i].dst, r.substitutable, r.weight, r.rationale);
        if (r.substitutable && r.weight > 0) added += 1;
      }
      done += 1;
      saveCounter += 1;
      // Persist every 20 batches so an interrupt doesn't lose much.
      if (saveCounter >= 20) {
        saveDraft(draft);
        saveCounter = 0;
      }
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = done / elapsed;
      const remaining = batches.length - done;
      const eta = remaining / rate;
      console.log(
        `[judge] ${done}/${batches.length} batches (${added} substitutes recorded, ${rate.toFixed(1)} batch/s, ETA ${Math.round(eta)}s)`,
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  saveDraft(draft);
  const totalEntries = Object.values(draft).reduce((n, arr) => n + arr.length, 0);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[judge] done in ${elapsed}s — draft has ${totalEntries} total substitute entries across ${Object.keys(draft).length} source codes`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[judge] failed:", err);
    process.exit(1);
  });
