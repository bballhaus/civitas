// Stage 1 of the NAICS substitutes matrix build.
//
// Generates the candidate pool — unordered code pairs that *might* be
// substitutable. The LLM judges each candidate in Stage 2.
//
// Two-source union:
//   (a) Hierarchy siblings (4-digit and 5-digit prefix matches). Cheap,
//       deterministic. Catches obvious near-relatives.
//   (b) Embedding kNN. For each code, take top-K nearest neighbors by
//       cosine of their NAICS titles. Catches cross-sector substitutes
//       that the hierarchy can't see (e.g. fence install at 238990 vs
//       332323; security wiring at 238210 vs 561621).
//
// Embedding test (scripts/test-naics-similarity.ts) showed that cosine on
// NAICS titles overrates substitutability between superficially-similar
// codes — so embeddings are unreliable for the *judgment* step. They're
// fine for *recall* though: high-recall + low-precision is exactly what we
// want from a candidate-retrieval pass.
//
// Output: scripts/naics-substitutes/.cache/naics-candidates.json
//   { pairs: [{a, b}, ...], stats: {...} }
//
// Usage: npm run naics:generate-candidates

import "dotenv/config";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { embedBatch, cosine } from "../../src/lib/embeddings";
import { NAICS_ENTRIES } from "../../src/data/filter-options";

const KNN_PER_CODE = 15;
const EMBEDDINGS_CACHE = "scripts/naics-substitutes/.cache/naics-title-embeddings.json";
const CANDIDATES_OUT = "scripts/naics-substitutes/.cache/naics-candidates.json";

interface EmbeddingsCache {
  model: string;
  embeddings: Record<string, number[]>; // code → vector
}

async function loadOrComputeEmbeddings(): Promise<Record<string, number[]>> {
  if (existsSync(EMBEDDINGS_CACHE)) {
    const cached = JSON.parse(readFileSync(EMBEDDINGS_CACHE, "utf8")) as EmbeddingsCache;
    const got = Object.keys(cached.embeddings).length;
    if (got === NAICS_ENTRIES.length) {
      console.log(`[candidates] loaded ${got} cached embeddings`);
      return cached.embeddings;
    }
    console.log(`[candidates] cache stale (${got} != ${NAICS_ENTRIES.length}) — re-embedding`);
  }

  console.log(`[candidates] embedding ${NAICS_ENTRIES.length} NAICS titles via Voyage...`);
  const titles = NAICS_ENTRIES.map((e) => e.title);
  const vectors = await embedBatch(titles, "document");
  const out: Record<string, number[]> = {};
  for (let i = 0; i < NAICS_ENTRIES.length; i++) {
    out[NAICS_ENTRIES[i].code] = vectors[i];
  }
  writeFileSync(
    EMBEDDINGS_CACHE,
    JSON.stringify({ model: "voyage-3-large", embeddings: out }),
  );
  console.log(`[candidates] cached embeddings → ${EMBEDDINGS_CACHE}`);
  return out;
}

function hierarchyCandidates(): Set<string> {
  // Pairs sharing first 4 digits OR first 5 digits. Key as "a|b" with a < b
  // so each unordered pair is stored once.
  const out = new Set<string>();
  const byPrefix = (n: number) => {
    const groups = new Map<string, string[]>();
    for (const e of NAICS_ENTRIES) {
      const k = e.code.slice(0, n);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(e.code);
    }
    for (const codes of groups.values()) {
      for (let i = 0; i < codes.length; i++) {
        for (let j = i + 1; j < codes.length; j++) {
          const [a, b] = [codes[i], codes[j]].sort();
          out.add(`${a}|${b}`);
        }
      }
    }
  };
  byPrefix(4);
  byPrefix(5);
  return out;
}

function knnCandidates(embeddings: Record<string, number[]>): Set<string> {
  const out = new Set<string>();
  const codes = Object.keys(embeddings);
  for (const a of codes) {
    const vecA = embeddings[a];
    // Score every other code, take top KNN_PER_CODE by cosine.
    const scored: { code: string; sim: number }[] = [];
    for (const b of codes) {
      if (b === a) continue;
      scored.push({ code: b, sim: cosine(vecA, embeddings[b]) });
    }
    scored.sort((x, y) => y.sim - x.sim);
    for (const { code: b } of scored.slice(0, KNN_PER_CODE)) {
      const [lo, hi] = [a, b].sort();
      out.add(`${lo}|${hi}`);
    }
  }
  return out;
}

async function main() {
  const embeddings = await loadOrComputeEmbeddings();

  console.log(`[candidates] generating hierarchy candidates...`);
  const hierarchy = hierarchyCandidates();
  console.log(`[candidates] hierarchy: ${hierarchy.size} pairs`);

  console.log(`[candidates] generating embedding-kNN candidates (K=${KNN_PER_CODE})...`);
  const knn = knnCandidates(embeddings);
  console.log(`[candidates] knn: ${knn.size} pairs`);

  const union = new Set<string>([...hierarchy, ...knn]);
  console.log(`[candidates] union: ${union.size} pairs (overlap = ${hierarchy.size + knn.size - union.size})`);

  const pairs = [...union].map((k) => {
    const [a, b] = k.split("|");
    return { a, b };
  });

  writeFileSync(
    CANDIDATES_OUT,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        stats: {
          hierarchy_pairs: hierarchy.size,
          knn_pairs: knn.size,
          union_pairs: union.size,
          knn_per_code: KNN_PER_CODE,
        },
        pairs,
      },
      null,
      2,
    ),
  );
  console.log(`[candidates] wrote ${pairs.length} candidate pairs → ${CANDIDATES_OUT}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[candidates] failed:", err);
    process.exit(1);
  });
