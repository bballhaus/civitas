// Embedding pipeline for the v2 matcher (Architecture-v2 § 8).
//
// Model: Voyage-3-large, 1024 dimensions. English-tuned. Stored in pgvector
// columns on specialties, capabilities, and rfp_cache. Refresh triggers
// (per spec): profile mutation for the user side, manifest refreshedAt bump
// for the RFP side.
//
// We hit Voyage's HTTP API directly — the spec calls for one model end-to-end
// and the volumes are tiny enough that adding an SDK is overkill (~$0.001 to
// embed a full profile, ~$0.36 for a full RFP catalog refresh per § 8).

import { eq, isNull, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  specialties,
  capabilities,
  rfpCache,
  profiles,
  type Specialty,
  type Capability,
  type RfpCacheRow,
} from "@/db/schema";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3-large";
const DIMENSIONS = 1024;
// Voyage's batch ceiling is 128 per request; we keep a healthy margin.
const BATCH_SIZE = 96;

export class EmbeddingConfigError extends Error {}

function requireApiKey(): string {
  // Accept either VOYAGE_API_KEY (Voyage SDK convention) or the shorter
  // VOYAGE_KEY some deployments use. Prefer the SDK-conventional name when
  // both are set so behavior matches upstream docs.
  const key = process.env.VOYAGE_API_KEY ?? process.env.VOYAGE_KEY;
  if (!key) {
    throw new EmbeddingConfigError(
      "Neither VOYAGE_API_KEY nor VOYAGE_KEY is set — cannot embed.",
    );
  }
  return key;
}

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

async function callVoyage(
  texts: string[],
  inputType: "query" | "document",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = requireApiKey();
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: inputType,
      output_dimension: DIMENSIONS,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Voyage embedding request failed (${res.status}): ${errText}`);
  }
  const json = (await res.json()) as VoyageResponse;
  // Voyage may return entries out of order; sort by index to keep alignment
  // with the input array a hard guarantee for callers.
  const out = new Array<number[]>(texts.length);
  for (const row of json.data) {
    out[row.index] = row.embedding;
  }
  return out;
}

/**
 * Embed a single short text. Used for one-off calls where batching is moot
 * (e.g. embedding a brand-new specialty the user just typed).
 */
export async function embedText(
  text: string,
  inputType: "query" | "document" = "document",
): Promise<number[]> {
  const [v] = await callVoyage([text], inputType);
  return v;
}

/**
 * Embed an arbitrary batch of texts. Chunks above BATCH_SIZE.
 */
export async function embedBatch(
  texts: string[],
  inputType: "query" | "document" = "document",
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const chunk = texts.slice(i, i + BATCH_SIZE);
    const embedded = await callVoyage(chunk, inputType);
    out.push(...embedded);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Profile-side: embed any specialty/capability rows that have no embedding
// yet. Called from the onboarding "Finish" handler and from any code path
// that mutates these tables (specialty add/edit).
// ---------------------------------------------------------------------------

export async function refreshProfileEmbeddings(userId: string): Promise<{
  specialtyCount: number;
  capabilityCount: number;
  tokensUsed: number;
}> {
  const [needSpec, needCap] = await Promise.all([
    db
      .select()
      .from(specialties)
      .where(eq(specialties.userId, userId))
      .then((rows: Specialty[]) => rows.filter((r) => !r.embedding)),
    db
      .select()
      .from(capabilities)
      .where(eq(capabilities.userId, userId))
      .then((rows: Capability[]) => rows.filter((r) => !r.embedding)),
  ]);

  if (needSpec.length === 0 && needCap.length === 0) {
    await db
      .update(profiles)
      .set({ embeddingUpdatedAt: new Date() })
      .where(eq(profiles.userId, userId));
    return { specialtyCount: 0, capabilityCount: 0, tokensUsed: 0 };
  }

  const allTexts = [...needSpec.map((s) => s.value), ...needCap.map((c) => c.value)];
  const vectors = await embedBatch(allTexts, "document");

  // Write back in two passes — drizzle doesn't have a multi-row update with
  // per-row values out of the box, so this is N UPDATEs. N is small (typical
  // user has ~30 rows total) so the round-trip overhead is fine.
  for (let i = 0; i < needSpec.length; i++) {
    await db
      .update(specialties)
      .set({ embedding: vectors[i] })
      .where(eq(specialties.id, needSpec[i].id));
  }
  for (let i = 0; i < needCap.length; i++) {
    await db
      .update(capabilities)
      .set({ embedding: vectors[needSpec.length + i] })
      .where(eq(capabilities.id, needCap[i].id));
  }
  await db
    .update(profiles)
    .set({ embeddingUpdatedAt: new Date() })
    .where(eq(profiles.userId, userId));

  return {
    specialtyCount: needSpec.length,
    capabilityCount: needCap.length,
    tokensUsed: allTexts.reduce((a, b) => a + Math.ceil(b.length / 4), 0),
  };
}

// ---------------------------------------------------------------------------
// RFP-side: build the embedding text per spec § 9.4 — heterogeneous sources
// give very different signal quality, so we feed the embedder whatever fields
// the source actually populated and let the matcher down-weight the result
// with semantic_confidence().
// ---------------------------------------------------------------------------

export function buildRfpEmbeddingText(rfp: RfpCacheRow): string {
  const parts: string[] = [rfp.title];
  if (rfp.description) parts.push(rfp.description);
  if (rfp.capabilities && rfp.capabilities.length > 0) {
    parts.push(rfp.capabilities.join(" "));
  }
  if (rfp.deliverables && rfp.deliverables.length > 0) {
    parts.push(rfp.deliverables.join(" "));
  }
  // The attachment-rollup summary lives in `raw` for now (no dedicated column
  // yet). Pull it when it's there — Cal eProcure has it; others don't.
  const raw = rfp.raw as Record<string, unknown> | null | undefined;
  const summary = raw && typeof raw === "object" && "attachment_rollup" in raw
    ? (raw.attachment_rollup as { summary?: string } | null)?.summary
    : undefined;
  if (summary) parts.push(summary);
  return parts.join(" ").slice(0, 16_000); // hard cap on token waste
}

/**
 * Compute and store embeddings for any RFP cache rows missing one.
 * Returns the count of embedded rows. Idempotent.
 */
export async function refreshRfpEmbeddings(maxRows = 500): Promise<number> {
  const rows = await db
    .select()
    .from(rfpCache)
    .where(or(isNull(rfpCache.embedding)))
    .limit(maxRows);

  if (rows.length === 0) return 0;

  const texts = rows.map((r) => buildRfpEmbeddingText(r));
  const vectors = await embedBatch(texts, "document");
  for (let i = 0; i < rows.length; i++) {
    await db
      .update(rfpCache)
      .set({ embedding: vectors[i], refreshedAt: new Date() })
      .where(eq(rfpCache.id, rows[i].id));
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Cosine similarity — useful when the matcher reads an embedding from one
// row and needs to compare it against another without an extra DB round-trip.
// pgvector handles this server-side via <=> for index-backed queries; this
// is the pure-JS path for the in-memory aggregation step.
// ---------------------------------------------------------------------------

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine dim mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
