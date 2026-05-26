// POST /api/cron/critique-rfp-tags — daily Sonnet audit of the Haiku NAICS
// tagging that the sync-rfp-cache cron writes. Picks up only rows with
// `naics_critiqued_at IS NULL`; the lib (src/lib/rfp-tag-critic.ts) marks
// each row as audited after Sonnet replies so the next pass skips it.
//
// Why a separate cron from sync-rfp-cache: Sonnet is ~3× more expensive
// than Haiku per call. Running it inline with every 12h scrape doubles the
// per-scrape spend and slows the live populate→tag→embed loop. A daily
// catch-up keeps the cost bounded (~$0.10/day at current churn) while
// letting users see Haiku tags within minutes of a scrape and corrections
// within 24h.
//
// Auth: shared bearer secret CIVITAS_CRON_SECRET (same as daily-roundup
// and sync-rfp-cache).
//
// Deployment: add an EventBridge rule + Lambda shim (reuse
// infra/notifications/lambda.mjs with CIVITAS_CRON_URL pointed at this
// route). See infra/notifications/README.md.

import { NextResponse, after } from "next/server";
import { critiqueUncritiquedRfps, CriticConfigError } from "@/lib/rfp-tag-critic";
import { refreshRfpEmbeddings, EmbeddingConfigError } from "@/lib/embeddings";
import { rescoreRfpsForAllUsers } from "@/lib/match-rescore";

export const runtime = "nodejs";
// Vercel Pro tier cap. Sonnet calls are slower than Haiku (~3-5s per
// batch of 5 with 6-way concurrency); 5 minutes comfortably handles
// daily catch-up volumes.
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

  try {
    let critiqueResult;
    try {
      critiqueResult = await critiqueUncritiquedRfps();
    } catch (err) {
      if (err instanceof CriticConfigError) {
        console.warn("[cron/critique-rfp-tags] skipping: ANTHROPIC_API_KEY missing");
        return NextResponse.json({
          ok: true,
          rows_considered: 0,
          rows_audited: 0,
          rows_changed: 0,
          rows_embedded: 0,
          critique_error: "ANTHROPIC_API_KEY not set",
          embed_error: null,
        });
      }
      throw err;
    }

    // Re-embed rows whose tags Sonnet changed — the critic sets their
    // embedding to NULL, so the standard `IS NULL` pass picks them up.
    let totalEmbedded = 0;
    let embedError: string | null = null;
    if (critiqueResult.changed > 0) {
      try {
        for (let pass = 0; pass < MAX_EMBED_PASSES; pass++) {
          const n = await refreshRfpEmbeddings(500);
          totalEmbedded += n;
          if (n === 0) break;
        }
      } catch (err) {
        if (err instanceof EmbeddingConfigError) {
          embedError = "VOYAGE_API_KEY not set";
          console.warn("[cron/critique-rfp-tags] skipping embeddings: VOYAGE_API_KEY missing");
        } else {
          embedError = err instanceof Error ? err.message : String(err);
          console.error("[cron/critique-rfp-tags] embed pass failed:", err);
        }
      }
    }

    // Background rescore: the corrected naics_codes feed the matcher's
    // NAICS gate and capability scoring. Runs after the response is
    // returned so the Lambda can hold the timeout for the critique+embed
    // work above.
    if (critiqueResult.changedIds.length > 0) {
      const ids = critiqueResult.changedIds.slice();
      after(async () => {
        await rescoreRfpsForAllUsers(ids);
      });
    }

    return NextResponse.json({
      ok: true,
      rows_considered: critiqueResult.rowsConsidered,
      rows_audited: critiqueResult.audited,
      rows_changed: critiqueResult.changed,
      rows_embedded: totalEmbedded,
      critique_error: null,
      embed_error: embedError,
      elapsed_ms: critiqueResult.elapsedMs,
    });
  } catch (err) {
    console.error("[cron/critique-rfp-tags] handler crashed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Internal error", message },
      { status: 500 },
    );
  }
}
