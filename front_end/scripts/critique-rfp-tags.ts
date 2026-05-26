// Sonnet 4.6 critiques the Haiku RFP NAICS tags from scripts/tag-rfp-naics.ts.
//
// Same quality-gate pattern as scripts/naics-substitutes/critique.ts:
// Haiku does the bulk pass cheaply, Sonnet audits each row and corrects
// the systematic mistakes Haiku makes (most commonly: tagging the agency
// instead of the work, picking adjacent-industry codes instead of the
// actual deliverable, over-tagging secondaries on single-trade RFPs).
//
// Resume-safe: pairs already in the critique JSON are skipped.
//
// Output: scripts/.cache/rfp-tag-critique.json
//   { critiques: [{ rfp_id, original_primary, original_secondary,
//                   agree, suggested_primary, suggested_secondary,
//                   concern }] }
//
// Usage: npm run rfp:critique-tags

import "dotenv/config";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../src/db/client";
import { rfpCache } from "../src/db/schema";
import { NAICS_ENTRIES } from "../src/data/filter-options";

const CACHE_DIR = "scripts/.cache";
const CRITIQUE_OUT = `${CACHE_DIR}/rfp-tag-critique.json`;

const MODEL = "claude-sonnet-4-6";
const RFPS_PER_BATCH = 5;
const CONCURRENCY = 6;
const VALID_CODES = new Set(NAICS_ENTRIES.map((e) => e.code));

const NAICS_LIST = NAICS_ENTRIES.map((e) => `${e.code} ${e.title}`).join("\n");

const SYSTEM_PROMPT = `You audit NAICS tagging on California government RFPs. Another evaluator (Haiku) assigned a primary NAICS + 0-4 secondary NAICS codes to each RFP. You critique each tagging for real-world correctness.

Known Haiku failure modes:
1. Tags the AGENCY instead of the WORK. "CHP Roof Maintenance" should be 238160 (Roofing), not law enforcement (922120). Never use sector 92 codes — those describe government bodies, not vendor work.
2. Confuses MATERIAL SUPPLY with INSTALLATION. "Purchase asphalt" = 324121 (manufacturer/supplier). "Apply asphalt overlay" = 237310 (highway construction installer). These are different vendors.
3. Over-tags secondaries on single-trade RFPs. A janitorial RFP is just 561720, not 561720+561740+561790. Only add secondaries when they represent work the prime CANNOT skip.
4. Picks ADJACENT INDUSTRY rather than EXACT WORK. "Software development for water management" is 541511 (Custom Programming), not 221310 (Water Supply). The work is programming.
5. Fabricates trades on cryptic-title-only RFPs. If the title is a project code with no description, the primary should still be a best guess BUT secondaries should be empty.

For each tagging you'll get: rfp_id, title, description, attachment_summary, original_primary, original_secondary. Decide:
- agree (bool): does the original tagging reflect the actual work being requested? Tolerate close calls (±1 sibling within a 4-digit group).
- suggested_primary (string): if you disagree, the correct primary code. If you agree, return the original.
- suggested_secondary (array): if you disagree, the corrected secondary list (0-4 codes). If you agree, return the original.
- concern (string, under 25 words): why you flagged this, or empty string if you agree.

You DISAGREE when:
- Primary is the wrong category entirely (the vendor needed is clearly different work)
- Primary tags the agency rather than the work (sector 92 codes, or e.g. 921xxx)
- Primary confuses supply with installation
- Secondaries contain codes that don't reflect required work
- Required secondaries are missing (e.g. multi-trade construction tagged with only the GC code)

You AGREE when:
- Primary code is correct or a defensible close sibling
- Secondaries are reasonable (if any) and not over-tagged

OUTPUT: Return ONLY a JSON array, one object per input RFP in the SAME ORDER. Each object: {"agree": boolean, "suggested_primary": "code", "suggested_secondary": ["code", ...], "concern": "string"}

NAICS CATALOG (use ONLY codes from this list):
${NAICS_LIST}`;

interface RfpForCritique {
  id: string;
  title: string;
  description: string | null;
  attachment_summary: string | null;
  original_primary: string;
  original_secondary: string[];
}

interface CritiqueResult extends RfpForCritique {
  agree: boolean;
  suggested_primary: string;
  suggested_secondary: string[];
  concern: string;
}

function loadExisting(): CritiqueResult[] {
  if (!existsSync(CRITIQUE_OUT)) return [];
  return (JSON.parse(readFileSync(CRITIQUE_OUT, "utf8")).critiques ?? []) as CritiqueResult[];
}

function saveCritiques(all: CritiqueResult[]) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  // Sort: disagreements first.
  const sorted = all.slice().sort((a, b) => {
    if (a.agree !== b.agree) return a.agree ? 1 : -1;
    return 0;
  });
  writeFileSync(
    CRITIQUE_OUT,
    JSON.stringify({ generated_at: new Date().toISOString(), critiques: sorted }, null, 2),
  );
}

async function critiqueBatch(
  client: Anthropic,
  items: RfpForCritique[],
): Promise<Array<{
  agree: boolean;
  suggested_primary: string;
  suggested_secondary: string[];
  concern: string;
} | null>> {
  const payload = items.map((it, i) => ({
    i,
    rfp_id: it.id,
    title: it.title,
    description: it.description ? it.description.slice(0, 1500) : "",
    attachment_summary: it.attachment_summary ? it.attachment_summary.slice(0, 800) : "",
    original_primary: it.original_primary,
    original_secondary: it.original_secondary,
  }));
  const userMessage = `Audit these ${items.length} RFP NAICS taggings:\n\n${JSON.stringify(payload, null, 2)}`;

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
      const parsed = JSON.parse(match[0]) as Array<{
        agree: boolean;
        suggested_primary: string;
        suggested_secondary: string[];
        concern: string;
      }>;
      if (!Array.isArray(parsed) || parsed.length !== items.length) {
        throw new Error(`bad shape: got ${Array.isArray(parsed) ? parsed.length : "non-array"}, expected ${items.length}`);
      }
      // Validate codes — silently drop invalid ones from secondaries; reject
      // the whole row if primary is invalid (will fall back to Haiku's tag).
      for (const r of parsed) {
        if (!VALID_CODES.has(r.suggested_primary)) {
          throw new Error(`invalid suggested_primary: ${r.suggested_primary}`);
        }
        r.suggested_secondary = (r.suggested_secondary ?? []).filter((c) => VALID_CODES.has(c));
      }
      return parsed;
    } catch (err) {
      attempt += 1;
      if (attempt >= 3) {
        console.warn(`[critique-tags] batch failed 3x, skipping ${items.length} RFPs: ${err}`);
        return items.map(() => null);
      }
      const backoff = 1500 * Math.pow(2, attempt);
      console.warn(`[critique-tags] attempt ${attempt} failed (${err}); retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function main() {
  const rows = await db
    .select({
      id: rfpCache.id,
      title: rfpCache.title,
      description: rfpCache.description,
      naicsCodes: rfpCache.naicsCodes,
      raw: rfpCache.raw,
    })
    .from(rfpCache);
  const tagged = rows.filter((r) => r.naicsCodes && r.naicsCodes.length > 0);
  console.log(`[critique-tags] ${tagged.length} tagged RFPs to audit`);

  const existing = loadExisting();
  const existingIds = new Set(existing.map((c) => c.id));
  const todo: RfpForCritique[] = tagged
    .filter((r) => !existingIds.has(r.id))
    .map((r) => {
      const raw = r.raw as Record<string, unknown> | null | undefined;
      const summary =
        raw && typeof raw === "object" && "attachment_rollup" in raw
          ? (raw.attachment_rollup as { summary?: string } | null)?.summary ?? null
          : null;
      const codes = r.naicsCodes ?? [];
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        attachment_summary: summary,
        original_primary: codes[0],
        original_secondary: codes.slice(1),
      };
    });

  console.log(`[critique-tags] ${existing.length} already audited, ${todo.length} to do`);
  if (todo.length === 0) return;

  const batches: RfpForCritique[][] = [];
  for (let i = 0; i < todo.length; i += RFPS_PER_BATCH) {
    batches.push(todo.slice(i, i + RFPS_PER_BATCH));
  }
  console.log(`[critique-tags] ${batches.length} batches of ${RFPS_PER_BATCH}, ${CONCURRENCY}-way parallel`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const newCritiques: CritiqueResult[] = [];
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
          suggested_primary: r.suggested_primary,
          suggested_secondary: r.suggested_secondary,
          concern: r.concern,
        });
      }
      done += 1;
      saveCounter += 1;
      if (saveCounter >= 20) {
        saveCritiques([...existing, ...newCritiques]);
        saveCounter = 0;
      }
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = (batches.length - done) / Math.max(0.001, done / elapsed);
      console.log(`[critique-tags] ${done}/${batches.length} batches (${(done / elapsed).toFixed(1)} b/s, ETA ${Math.round(eta)}s)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  saveCritiques([...existing, ...newCritiques]);
  const all = [...existing, ...newCritiques];
  const disagreed = all.filter((c) => !c.agree);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[critique-tags] done in ${elapsed}s — ${all.length} total, ${disagreed.length} flagged (${((disagreed.length / all.length) * 100).toFixed(0)}%)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[critique-tags] failed:", err);
    process.exit(1);
  });
