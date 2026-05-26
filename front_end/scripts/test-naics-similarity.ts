// One-off empirical test: do Voyage embeddings of NAICS titles actually
// produce sensible "can this vendor interchange?" similarities?
//
// Method: hand-pick pairs across three categories
//   (1) Should be HIGH (vendors really can interchange)
//   (2) Should be LOW despite NAICS hierarchy proximity (the cases that
//       break naive 4-digit-fallback)
//   (3) Should be HIGH despite hierarchy distance (cases pure-hierarchy
//       fallback would miss)
//
// Cosine output is printed sorted. If embeddings get the categories right,
// they're a viable similarity function. If they don't, hand-curate it is.

import "dotenv/config";
import { embedBatch, cosine } from "../src/lib/embeddings";
import { NAICS_MAP } from "../src/data/filter-options";

type Verdict = "HIGH" | "LOW";
interface Pair {
  a: string; // NAICS code
  b: string; // NAICS code
  expected: Verdict;
  reason: string;
}

const PAIRS: Pair[] = [
  // ---------- Category 1: should be HIGH (interchangeable in practice)
  { a: "541511", b: "541512", expected: "HIGH", reason: "Custom programming ↔ systems design — same talent pool" },
  { a: "541611", b: "541618", expected: "HIGH", reason: "Admin mgmt consulting ↔ other mgmt consulting" },
  { a: "236115", b: "236116", expected: "HIGH", reason: "Single-family ↔ multifamily housing — same residential trade" },
  { a: "236210", b: "236220", expected: "HIGH", reason: "Industrial building ↔ commercial building — same nonresidential GC trade" },

  // ---------- Category 2: should be LOW despite hierarchy proximity (the breakers)
  { a: "238110", b: "238160", expected: "LOW", reason: "Concrete foundation ↔ roofing — both 2381 siblings, totally different trades (C-8 vs C-39)" },
  { a: "238110", b: "238150", expected: "LOW", reason: "Concrete foundation ↔ glass/glazing — 2381 siblings, different trades" },
  { a: "236115", b: "236220", expected: "LOW", reason: "Residential housing ↔ commercial/institutional — different bonding, supervision, capital" },
  { a: "335210", b: "335220", expected: "LOW", reason: "Small appliance mfg ↔ major appliance mfg — 3352 siblings, can't retool" },
  { a: "541330", b: "541320", expected: "LOW", reason: "Engineering services ↔ landscape architecture — 5413 siblings, different professions" },
  { a: "238210", b: "238220", expected: "LOW", reason: "Electrical contractors ↔ plumbing/HVAC — 2382 siblings, different licenses entirely" },

  // ---------- Category 3: should be HIGH despite hierarchy distance
  { a: "541511", b: "541519", expected: "HIGH", reason: "Custom programming ↔ other computer services — close but not 5-digit sibling" },
  { a: "561720", b: "561740", expected: "HIGH", reason: "Janitorial ↔ carpet cleaning — different 4-digit but same buyer/skill set" },
];

async function main() {
  // Resolve unique titles, embed once each.
  const uniqueCodes = Array.from(new Set(PAIRS.flatMap((p) => [p.a, p.b])));
  const titles = uniqueCodes.map((code) => {
    const title = NAICS_MAP[code];
    if (!title) throw new Error(`No NAICS title for ${code}`);
    return title;
  });
  console.log(`[naics-test] embedding ${titles.length} unique titles...`);
  const vectors = await embedBatch(titles, "document");
  const vecByCode = new Map<string, number[]>(uniqueCodes.map((c, i) => [c, vectors[i]]));

  // Score each pair.
  type Row = Pair & { sim: number; pass: boolean };
  const rows: Row[] = PAIRS.map((p) => {
    const sim = cosine(vecByCode.get(p.a)!, vecByCode.get(p.b)!);
    // Use 0.78 as the inflection point — picked so that HIGH expected pairs
    // should land above and LOW expected pairs below. We'll see if it holds.
    const pass = (p.expected === "HIGH" && sim >= 0.78) || (p.expected === "LOW" && sim < 0.78);
    return { ...p, sim, pass };
  });

  // Print sorted by similarity descending so the order tells the story.
  rows.sort((x, y) => y.sim - x.sim);
  console.log("");
  console.log("sim    | expect | pass | A — B");
  console.log("-------|--------|------|----------------------------------------");
  for (const r of rows) {
    const aTitle = NAICS_MAP[r.a];
    const bTitle = NAICS_MAP[r.b];
    console.log(
      `${r.sim.toFixed(3)} | ${r.expected.padEnd(6)} | ${r.pass ? "✓" : "✗"}    | ${r.a} ${aTitle} ↔ ${r.b} ${bTitle}`,
    );
    console.log(`       |        |      |   ${r.reason}`);
  }
  const passed = rows.filter((r) => r.pass).length;
  console.log("");
  console.log(`[naics-test] ${passed}/${rows.length} pairs match expected verdict at 0.78 threshold`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[naics-test] failed:", err);
    process.exit(1);
  });
