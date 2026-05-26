// Server-side derive: profile.naics_codes is the union of three sources:
//   (a) codes the user explicitly picked on the NAICS step
//   (b) codes implied by NAICS-titled specialties/capabilities (exact title match)
//   (c) codes LLM-inferred from free-text specialties/capabilities
//
// (c) is the launch-critical path: small contractors describe their work in
// vernacular ("concrete flatwork", "fiber optic installation"), not in
// NAICS taxonomy language. Without LLM inference, free-text users have empty
// naics_codes and the Capability scorer in matching-v2 returns neutral —
// effectively excluding them from good matches.
//
// Why this lives here instead of in the onboarding client: the client-side
// propagation in onboarding/Steps.tsx misses backfill, free-text-then-edit,
// /profile-setup mutations, API-direct adds, and rapid-pick races. The server
// is the only place that sees every write path, so the derive belongs here
// and is called from every mutation endpoint that touches specialties or
// capabilities.

import { eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db/client";
import { profiles, specialties, capabilities } from "@/db/schema";
import { NAICS_ENTRIES } from "@/data/filter-options";

// NAICS titles are unique in the 2022 catalog, so a title→code reverse map is
// unambiguous. Normalize on lowercase+trim so casing/whitespace drift in user
// input doesn't break the lookup.
const TITLE_TO_CODE: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const { code, title } of NAICS_ENTRIES) {
    m.set(title.toLowerCase().trim(), code);
  }
  return m;
})();

function naicsForText(text: string): string | undefined {
  return TITLE_TO_CODE.get(text.toLowerCase().trim());
}

// In-process cache for LLM inference. Most free-text values repeat across
// users ("concrete flatwork", "electrical wiring", etc.) so caching avoids
// re-paying Haiku for the same string. Keyed by lowercase+trim of the
// value. Persists for the lifetime of the Node process (per-deployment).
const VALID_CODES = new Set(NAICS_ENTRIES.map((e) => e.code));
const INFERENCE_CACHE = new Map<string, string[]>();

const NAICS_LIST = NAICS_ENTRIES.map((e) => `${e.code} ${e.title}`).join("\n");

const INFERENCE_SYSTEM_PROMPT = `You map free-text contractor specialty/capability descriptions to 6-digit NAICS codes. Each input describes a kind of work a small contractor performs (e.g. "concrete flatwork", "fiber optic installation", "asphalt paving"). For each input, return 1-3 NAICS codes that classify the work.

RULES:
1. Pick codes for the WORK, not the customer or industry served.
2. Use ONLY codes from the catalog below. Do not invent codes.
3. Be conservative: return [] if the input is too vague or generic to classify (e.g. "consulting", "services"). False positives hurt matching.
4. For multi-skill phrases (e.g. "plumbing and electrical"), return one code per discrete trade.
5. Prefer the most specific code over a broader parent.

WORD-SIMILARITY TRAPS — common mistakes to avoid:
- "PAVING" is road/asphalt work (237310 Highway/Street/Bridge), NOT "PAINTING" (238320 Painting/Wall Covering). These trades have nothing in common.
- "PAVING" is also NOT "POURING" (concrete work, 238110). Distinct trades, different licenses.
- "WIRING" is electrical (238210), not telecom (517xxx) — telecom is a service provider, not an installer.
- "INSTALLATION" alone is too vague to classify — what's being installed determines the code.

WORKED EXAMPLES (correct mappings for common contractor terms):
- "concrete flatwork" → 238110 (Poured Concrete Foundation and Structure Contractors)
- "asphalt paving" → 237310 (Highway, Street, and Bridge Construction)
- "electrical wiring" → 238210 (Electrical Contractors and Other Wiring Installation Contractors)
- "fiber optic installation" → 238210 or 237130 (Power and Communication Line and Related Structures Construction) — pick 237130 if context suggests outdoor/utility cable, otherwise 238210
- "plumbing installation" → 238220 (Plumbing, Heating, and Air-Conditioning Contractors)
- "HVAC repair" → 238220 (Plumbing, Heating, and Air-Conditioning Contractors)
- "roofing repair" → 238160 (Roofing Contractors)
- "drywall installation" → 238310 (Drywall and Insulation Contractors)
- "tile installation" → 238340 (Tile and Terrazzo Contractors)
- "tree trimming" → 561730 (Landscaping Services) or 115310 (Support Activities for Forestry)
- "janitorial services" → 561720 (Janitorial Services)
- "fence installation" → 238990 (All Other Specialty Trade Contractors)
- "custom software" → 541511 (Custom Computer Programming Services)
- "web development" → 541511 (Custom Computer Programming Services)
- "grant writing" → 541611 (Administrative Management Consulting) or 541990 (Other Professional Services)

OUTPUT: Return ONLY a JSON array, one object per input in the SAME ORDER. Each object: {"input": "the original string", "naics_codes": ["code", "code", ...]}.

NAICS CATALOG (use ONLY codes from this list):
${NAICS_LIST}`;

/**
 * LLM-infer NAICS codes for an array of free-text values. Batched into a
 * single Haiku call to amortize the 30K-token cached system prompt.
 *
 * Cached: repeated values across calls hit the in-process map and skip
 * the LLM entirely. Returns codes restricted to the catalog (any
 * hallucinations are silently dropped).
 *
 * Fail-soft: on API error returns [] for every input. Caller should treat
 * empty arrays as "no inference available" not "no codes apply."
 */
export async function inferNaicsForTexts(values: string[]): Promise<string[][]> {
  // Resolve from cache first; only un-cached values hit Haiku.
  const out: string[][] = new Array(values.length).fill(null).map(() => [] as string[]);
  const todo: { idx: number; value: string }[] = [];
  for (let i = 0; i < values.length; i++) {
    const key = values[i].toLowerCase().trim();
    const cached = INFERENCE_CACHE.get(key);
    if (cached) {
      out[i] = cached;
    } else {
      todo.push({ idx: i, value: values[i] });
    }
  }
  if (todo.length === 0) return out;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[profile-naics] no ANTHROPIC_API_KEY — skipping LLM inference");
    return out;
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const payload = todo.map((t, i) => ({ i, input: t.value }));
    const userMessage = `Classify the following ${todo.length} contractor specialty/capability descriptions:\n\n${JSON.stringify(payload, null, 2)}`;
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: [
        { type: "text", text: INFERENCE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userMessage }],
    });
    const block = response.content[0];
    const raw = block.type === "text" ? block.text : "";
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("no JSON array in response");
    const parsed = JSON.parse(match[0]) as Array<{ input: string; naics_codes: string[] }>;
    if (!Array.isArray(parsed) || parsed.length !== todo.length) {
      throw new Error(`bad shape: got ${Array.isArray(parsed) ? parsed.length : "non-array"}, expected ${todo.length}`);
    }
    for (let i = 0; i < todo.length; i++) {
      const codes = (parsed[i].naics_codes ?? []).filter((c) => VALID_CODES.has(c));
      const key = todo[i].value.toLowerCase().trim();
      INFERENCE_CACHE.set(key, codes);
      out[todo[i].idx] = codes;
    }
  } catch (err) {
    console.error("[profile-naics] LLM inference failed:", err);
    // Cache the failure as [] so retries don't pound the API on the same
    // input. The next time the user edits their profile we'll try again
    // because a fresh process loses the cache.
    for (const t of todo) {
      INFERENCE_CACHE.set(t.value.toLowerCase().trim(), []);
    }
  }
  return out;
}

/**
 * Recompute and persist profile.naics_codes for a single user.
 *
 * Reads the user's specialties + capabilities, then:
 *   1. Maps any value that exactly matches a NAICS title to its 6-digit code.
 *   2. For the remaining free-text values, asks Haiku to infer 1-3 NAICS codes
 *      (cached per-value, fail-soft on API errors).
 *   3. Unions both sources with the codes already on the profile (explicit
 *      picks from the dedicated NAICS step survive).
 *
 * Loose semantics: existing codes are preserved even if the underlying
 * specialty/capability was removed. Matches the existing onboarding
 * hook's behavior and avoids surprising the user.
 *
 * Idempotent. Safe to call on every spec/cap mutation and from the backfill.
 */
export interface RecomputeResult {
  /** Final, persisted NAICS code list (union of all sources, sorted). */
  codes: string[];
  /** Subset of `codes` that were newly added by this recompute call —
   *  i.e. not previously on the profile. The onboarding UI uses this to
   *  surface "we mapped your free-text entry to NAICS X" chips so users
   *  can spot and remove bad LLM inferences (e.g. asphalt-paving → painting). */
  added: string[];
}

export async function recomputeProfileNaics(userId: string): Promise<RecomputeResult> {
  const [specs, caps, profileRows] = await Promise.all([
    db
      .select({ value: specialties.value })
      .from(specialties)
      .where(eq(specialties.userId, userId)),
    db
      .select({ value: capabilities.value })
      .from(capabilities)
      .where(eq(capabilities.userId, userId)),
    db
      .select({ naicsCodes: profiles.naicsCodes })
      .from(profiles)
      .where(eq(profiles.userId, userId)),
  ]);

  const existing = new Set<string>(profileRows[0]?.naicsCodes ?? []);
  const merged = new Set<string>(existing);

  // Pass 1: exact NAICS title match (no LLM cost).
  const freeTextValues: string[] = [];
  for (const { value } of [...specs, ...caps]) {
    const code = naicsForText(value);
    if (code) {
      merged.add(code);
    } else {
      freeTextValues.push(value);
    }
  }

  // Pass 2: LLM-infer NAICS for free-text values. Batched + cached.
  if (freeTextValues.length > 0) {
    const inferred = await inferNaicsForTexts(freeTextValues);
    for (const codes of inferred) {
      for (const c of codes) merged.add(c);
    }
  }

  const codes = [...merged].sort();
  const added = codes.filter((c) => !existing.has(c));
  await db
    .update(profiles)
    .set({ naicsCodes: codes })
    .where(eq(profiles.userId, userId));
  return { codes, added };
}
