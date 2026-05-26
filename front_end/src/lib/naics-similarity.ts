// NAICS substitutability lookup. Reads the hand-curated/LLM-judged matrix at
// src/data/naics-substitutes.json (built by scripts/naics-substitutes/*.ts)
// and exposes a single `lookupNaicsSimilarity(a, b)` function used by the
// matcher.
//
// Returns 0-1:
//   1.00 — exact code match (a === b)
//   curated weight — if matrix[a] lists b as a substitute (directed)
//   0    — no relationship
//
// Directed: lookupNaicsSimilarity(vendor, rfp) is NOT the same as
// lookupNaicsSimilarity(rfp, vendor). A GC (236220) can plausibly sub out
// plumbing (238220) — so 236220→238220 has weight; a plumber cannot prime
// a GC contract — so 238220→236220 is zero. The matrix reflects this.

import substitutesData from "@/data/naics-substitutes.json";

interface MatrixEntry {
  code: string;
  weight: number;
  rationale: string;
}

interface SubstitutesFile {
  stats: Record<string, unknown>;
  matrix: Record<string, MatrixEntry[]>;
}

const MATRIX: Record<string, Map<string, MatrixEntry>> = (() => {
  const raw = (substitutesData as unknown as SubstitutesFile).matrix;
  const out: Record<string, Map<string, MatrixEntry>> = {};
  for (const src of Object.keys(raw)) {
    const m = new Map<string, MatrixEntry>();
    for (const entry of raw[src]) m.set(entry.code, entry);
    out[src] = m;
  }
  return out;
})();

/**
 * Directed substitutability: how well does a vendor classified under
 * `vendorCode` cover work classified under `rfpCode`?
 *
 * Returns 1.0 for exact match, the matrix-curated weight (0..1) if listed
 * as a substitute, or 0 if not related.
 */
export function lookupNaicsSimilarity(vendorCode: string, rfpCode: string): number {
  if (vendorCode === rfpCode) return 1.0;
  const entry = MATRIX[vendorCode]?.get(rfpCode);
  return entry ? entry.weight : 0;
}

/**
 * Like `lookupNaicsSimilarity` but also returns the curated rationale so
 * the matcher can surface it in explanations. Returns `null` for no-match
 * so callers can distinguish "exact" (sim=1, rationale=undefined) from
 * "substitute" (sim<1, rationale=string) from "nothing" (null).
 */
export function lookupNaicsSimilarityDetailed(
  vendorCode: string,
  rfpCode: string,
): { sim: number; rationale?: string } | null {
  if (vendorCode === rfpCode) return { sim: 1.0 };
  const entry = MATRIX[vendorCode]?.get(rfpCode);
  if (!entry) return null;
  return { sim: entry.weight, rationale: entry.rationale };
}

/**
 * Best-substitute search: given one vendor code and many candidate RFP
 * codes, returns the highest-scoring (rfpCode, sim, rationale) tuple. Used
 * when the matcher has multiple RFP NAICS codes (primary + secondaries)
 * and wants the best match for one of the vendor's codes.
 */
export function bestSubstituteFor(
  vendorCode: string,
  candidates: string[],
): { code: string; sim: number; rationale?: string } | null {
  let best: { code: string; sim: number; rationale?: string } | null = null;
  for (const candidate of candidates) {
    const r = lookupNaicsSimilarityDetailed(vendorCode, candidate);
    if (!r) continue;
    if (!best || r.sim > best.sim) {
      best = { code: candidate, sim: r.sim, rationale: r.rationale };
    }
  }
  return best;
}
