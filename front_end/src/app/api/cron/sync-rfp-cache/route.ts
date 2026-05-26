// POST /api/cron/sync-rfp-cache — pull fresh manifests into rfp_cache and
// embed any rows with NULL embeddings. Called by the scrape Lambda after
// each batch completes (fire-and-forget), so Postgres + Voyage stay in
// sync with S3 without a separate scheduled job.
//
// Body (optional): { "source_id": "planetbids_san_diego" }
//   - With source_id: load just that one manifest (~hot path after a batch).
//   - Without: full sweep of every manifest prefix (cold-start backfill).
//
// Auth: shared bearer secret CIVITAS_CRON_SECRET (same as daily-roundup).
//
// Embedding cap: we run refreshRfpEmbeddings in a loop bounded by
// MAX_EMBED_PASSES so a single request can't blow the Vercel timeout when
// the catalog is cold. Anything not embedded this call gets picked up on
// the next sync.

import { NextResponse, after } from "next/server";
import { loadAndMirrorOneSource, populateRfpCacheFromV2Manifests } from "@/lib/rfp-cache-populator";
import { refreshRfpEmbeddings, EmbeddingConfigError } from "@/lib/embeddings";
import { rescoreRfpsRefreshedSince } from "@/lib/match-rescore";

export const runtime = "nodejs";
// Vercel Pro tier allows up to 300s. Voyage's 21s inter-batch sleep means
// a single 500-row pass takes ~3-5 minutes; keep the cap generous.
export const maxDuration = 300;

const MAX_EMBED_PASSES = 5;

export async function POST(request: Request) {
  const expected = process.env.CIVITAS_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "CIVITAS_CRON_SECRET is not set" },
      { status: 500 },
    );
  }
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let sourceId: string | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      source_id?: string;
    };
    sourceId = body.source_id?.trim() || undefined;
  } catch {
    // Empty body is fine — falls through to full sweep.
  }

  // Capture before we touch rfp_cache. Any row whose refreshedAt is >= this
  // cutoff after the sync completes is something the populator just touched
  // (inserted or updated), and is a candidate for background re-scoring.
  const syncStartedAt = new Date();

  try {
    const mirror = sourceId
      ? await loadAndMirrorOneSource(sourceId)
      : await populateRfpCacheFromV2Manifests();

    let totalEmbedded = 0;
    let embedError: string | null = null;
    try {
      for (let pass = 0; pass < MAX_EMBED_PASSES; pass++) {
        const n = await refreshRfpEmbeddings(500);
        totalEmbedded += n;
        if (n === 0) break;
      }
    } catch (err) {
      if (err instanceof EmbeddingConfigError) {
        embedError = "VOYAGE_API_KEY not set";
        console.warn("[cron/sync-rfp-cache] skipping embeddings: VOYAGE_API_KEY missing");
      } else {
        embedError = err instanceof Error ? err.message : String(err);
        console.error("[cron/sync-rfp-cache] embed pass failed:", err);
      }
    }

    // Background rescore: new/updated RFPs should appear in every user's
    // cached match_state. Runs after the response is returned so the Lambda
    // can hold the timeout for the populator + embed work above.
    if (mirror.rowsUpserted > 0) {
      after(async () => {
        await rescoreRfpsRefreshedSince(syncStartedAt);
      });
    }

    return NextResponse.json({
      ok: true,
      source_id: sourceId ?? null,
      manifests_read: mirror.manifestsRead,
      events_total: mirror.eventsTotal,
      rows_upserted: mirror.rowsUpserted,
      bidders_inserted: mirror.biddersInserted,
      rows_embedded: totalEmbedded,
      embed_error: embedError,
    });
  } catch (err) {
    console.error("[cron/sync-rfp-cache] handler crashed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Internal error", message },
      { status: 500 },
    );
  }
}
