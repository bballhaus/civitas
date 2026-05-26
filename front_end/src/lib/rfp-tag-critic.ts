// Sonnet 4.6 audit of the Haiku NAICS tagging in src/lib/rfp-tagger.ts.
//
// The same quality-gate pattern used in scripts/naics-substitutes/critique.ts:
// Haiku does the bulk pass cheaply, Sonnet audits each row and corrects the
// systematic mistakes Haiku makes (tagging the agency instead of the work,
// picking adjacent-industry codes, over-tagging secondaries on single-trade
// RFPs). The 2026-05-25 bulk audit had Sonnet disagree with ~41% of Haiku's
// tags — enough signal that it's worth running automatically rather than
// trusting Haiku output unconditionally.
//
// Cron driver: /api/cron/critique-rfp-tags (daily). Only rows with
// `naics_critiqued_at IS NULL` are picked up; once a row is audited the
// timestamp is set (regardless of agreement) so the next pass skips it.
// When Sonnet disagrees we ALSO null out `embedding` so the next embed
// sweep recomputes against the corrected NAICS titles.

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rfpCache } from "@/db/schema";
import { NAICS_ENTRIES } from "@/data/filter-options";

const MODEL = "claude-sonnet-4-6";
const RFPS_PER_BATCH = 5;
const DEFAULT_CONCURRENCY = 6;
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

interface CritiqueInput {
  id: string;
  title: string;
  description: string | null;
  attachment_summary: string | null;
  original_primary: string;
  original_secondary: string[];
}

interface CritiqueRaw {
  agree: boolean;
  suggested_primary: string;
  suggested_secondary: string[];
  concern: string;
}

export class CriticConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriticConfigError";
  }
}

async function critiqueBatch(
  client: Anthropic,
  items: CritiqueInput[],
): Promise<Array<CritiqueRaw | null>> {
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
      const parsed = JSON.parse(match[0]) as CritiqueRaw[];
      if (!Array.isArray(parsed) || parsed.length !== items.length) {
        throw new Error(`bad shape: got ${Array.isArray(parsed) ? parsed.length : "non-array"}, expected ${items.length}`);
      }
      // Reject the whole row if primary is invalid; silently drop invalid
      // secondaries (matches the CLI critique behavior).
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
        console.warn(`[critique] batch failed 3x, skipping ${items.length} RFPs: ${err}`);
        return items.map(() => null);
      }
      const backoff = 2000 * Math.pow(2, attempt);
      console.warn(`[critique] attempt ${attempt} failed (${err}); retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

export interface CritiqueRunResult {
  rowsConsidered: number;
  audited: number;
  changed: number;
  changedIds: string[];
  elapsedMs: number;
}

/**
 * Critique tagged rows that haven't yet been audited.
 *
 * Selection: `naics_critiqued_at IS NULL AND scope_summary IS NOT NULL AND
 * array_length(naics_codes, 1) >= 1`. Un-tagged rows are skipped — the
 * tagger will handle them first; critique runs over the tagger's output.
 *
 * Persistence per row:
 *   - Sonnet AGREE → set `naics_critiqued_at = now()`. No other writes.
 *   - Sonnet DISAGREE → set `naics_codes` to the corrected list, NULL out
 *     `embedding` (so the next embed sweep refreshes against the new
 *     industry titles), and set `naics_critiqued_at = now()`.
 *
 * Returns the changed IDs so the caller can rescore match_state in the
 * background.
 *
 * `maxRows` caps the per-call workload to keep a single cron under the
 * Vercel timeout. Anything left over rolls into the next daily run.
 */
export async function critiqueUncritiquedRfps(
  maxRows = 500,
  options: { concurrency?: number; log?: boolean } = {},
): Promise<CritiqueRunResult> {
  const log = options.log ?? false;
  const startedAt = Date.now();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new CriticConfigError("ANTHROPIC_API_KEY not set");
  }

  const rows = await db
    .select({
      id: rfpCache.id,
      title: rfpCache.title,
      description: rfpCache.description,
      naicsCodes: rfpCache.naicsCodes,
      raw: rfpCache.raw,
    })
    .from(rfpCache)
    .where(
      and(
        isNull(rfpCache.naicsCritiquedAt),
        isNotNull(rfpCache.scopeSummary),
        sql`array_length(${rfpCache.naicsCodes}, 1) >= 1`,
      ),
    )
    .limit(maxRows);

  if (rows.length === 0) {
    if (log) console.log("[critique] 0 RFPs to audit");
    return { rowsConsidered: 0, audited: 0, changed: 0, changedIds: [], elapsedMs: 0 };
  }

  const inputs: CritiqueInput[] = rows.map((r) => {
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

  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const batches: CritiqueInput[][] = [];
  for (let i = 0; i < inputs.length; i += RFPS_PER_BATCH) {
    batches.push(inputs.slice(i, i + RFPS_PER_BATCH));
  }
  if (log) {
    console.log(`[critique] ${batches.length} batches of ${RFPS_PER_BATCH} RFPs, ${concurrency}-way parallel`);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let done = 0;
  let audited = 0;
  let changed = 0;
  const changedIds: string[] = [];
  const queue = batches.slice();
  const now = new Date();

  async function worker() {
    while (queue.length > 0) {
      const batch = queue.shift();
      if (!batch) break;
      const results = await critiqueBatch(client, batch);
      for (let i = 0; i < batch.length; i++) {
        const r = results[i];
        if (!r) continue;
        audited += 1;
        const item = batch[i];
        const originalCodes = [item.original_primary, ...item.original_secondary];
        const newCodes = [r.suggested_primary, ...r.suggested_secondary];
        const tagsChanged =
          !r.agree &&
          (originalCodes.length !== newCodes.length ||
            originalCodes.some((c, idx) => c !== newCodes[idx]));
        if (tagsChanged) {
          await db
            .update(rfpCache)
            .set({
              naicsCodes: newCodes,
              embedding: null,
              naicsCritiquedAt: now,
            })
            .where(eq(rfpCache.id, item.id));
          changed += 1;
          changedIds.push(item.id);
        } else {
          await db
            .update(rfpCache)
            .set({ naicsCritiquedAt: now })
            .where(eq(rfpCache.id, item.id));
        }
      }
      done += 1;
      if (log) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const eta = (batches.length - done) / Math.max(0.001, done / elapsed);
        console.log(
          `[critique] ${done}/${batches.length} batches | audited=${audited} changed=${changed} | ${(done / elapsed).toFixed(1)} b/s, ETA ${Math.round(eta)}s`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    rowsConsidered: rows.length,
    audited,
    changed,
    changedIds,
    elapsedMs: Date.now() - startedAt,
  };
}
