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
import { NAICS_MAP } from "@/data/filter-options";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3-large";
const DIMENSIONS = 1024;
// Voyage's free tier caps at 10K TPM. At ~150 tokens per short text, a batch
// of 40 lands at ~6K tokens — comfortably under the limit so a single
// request doesn't get auto-rejected. Paid tiers can comfortably push 96.
const BATCH_SIZE = Number(process.env.VOYAGE_BATCH_SIZE ?? 40);
// Free tier is also 3 RPM. Sleep this many ms between batches so a single
// script run doesn't tripwire the limiter. Set to 0 on paid tiers.
const INTER_BATCH_DELAY_MS = Number(process.env.VOYAGE_BATCH_DELAY_MS ?? 21_000);
// 429 retry budget — we retry with exponential backoff in addition to the
// fixed inter-batch delay so transient throttling self-heals.
const MAX_RETRIES = 5;

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

  let attempt = 0;
  for (;;) {
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

    if (res.ok) {
      const json = (await res.json()) as VoyageResponse;
      // Voyage may return entries out of order; sort by index so the
      // caller gets vectors aligned with its input array.
      const out = new Array<number[]>(texts.length);
      for (const row of json.data) {
        out[row.index] = row.embedding;
      }
      return out;
    }

    // 429 = rate limit. Respect Retry-After if present; otherwise back off
    // exponentially. Free tier is 3 RPM so 20-40s waits are normal here.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const backoff = Math.max(
        retryAfter * 1000,
        Math.min(60_000, 5_000 * Math.pow(2, attempt)),
      );
      console.warn(`[voyage] 429 rate-limited, sleeping ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoff);
      attempt += 1;
      continue;
    }

    const errText = await res.text();
    throw new Error(`Voyage embedding request failed (${res.status}): ${errText}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // Stay below the configured RPM ceiling between batches. Skipped for
    // the last batch — no point sleeping after the final write.
    if (INTER_BATCH_DELAY_MS > 0 && i + BATCH_SIZE < texts.length) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
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
  // Section-labeled format. Voyage handles labeled blocks well and the
  // labels give the embedder explicit signal about what each chunk is
  // (vs the pre-2026-05-26 implementation which joined everything by
  // single space and forced the model to guess section boundaries).
  const sections: string[] = [`Title: ${rfp.title}`];

  // Scope summary is the LLM-generated 1-2 sentence description (from
  // scripts/tag-rfp-naics.ts). For thin sources (PlanetBids/SF City/
  // BidSync, ~75% of catalog) this is the densest signal we have — it
  // expands abbreviated titles ("EXT REC CON26-0047 Union Sq Cafe") into
  // factual scope ("Operate a full-service café in Union Square...").
  if (rfp.scopeSummary) sections.push(`Scope: ${rfp.scopeSummary}`);

  if (rfp.description) sections.push(`Description: ${rfp.description}`);

  if (rfp.deliverables && rfp.deliverables.length > 0) {
    sections.push(`Deliverables: ${rfp.deliverables.join(", ")}`);
  }

  // NAICS titles (resolved from codes) give the embedder formal industry
  // vocabulary so contractor specialty/capability vectors can match against
  // the language RFPs use. Bare numeric codes would be near-noise.
  if (rfp.naicsCodes && rfp.naicsCodes.length > 0) {
    const titles = rfp.naicsCodes
      .map((code) => NAICS_MAP[code])
      .filter((title): title is string => Boolean(title));
    if (titles.length > 0) sections.push(`Industries: ${titles.join("; ")}`);
  }

  // Attachment-rollup summary lives in `raw` jsonb (Cal eProcure populates
  // it from PDF extraction; other sources empty). Worth keeping alongside
  // scope_summary because the attachment summary often surfaces concrete
  // technical specs the LLM-generated scope_summary won't.
  const raw = rfp.raw as Record<string, unknown> | null | undefined;
  const attachSummary = raw && typeof raw === "object" && "attachment_rollup" in raw
    ? (raw.attachment_rollup as { summary?: string } | null)?.summary
    : undefined;
  if (attachSummary) sections.push(`Attachment Summary: ${attachSummary}`);

  return sections.join("\n\n").slice(0, 16_000); // hard cap on token waste
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
