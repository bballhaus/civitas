// GET /api/match/{rfpId}/ — single match with full breakdown + citations
// + data_quality + sub track (Architecture-v2 § 11).
//
// The detail panel calls this. Heavier payload than the list view —
// includes every CategoryBreakdown row, the sub-track parallel scoring,
// and the incumbent state machine output so the UI can render the chips
// and the explanation copy.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { rfpCache } from "@/db/schema";
import { getFullProfile } from "@/db/queries/profile";
import { matchV2 } from "@/lib/matching-v2";
import { visibleRfpSourceClause } from "@/lib/rfp-source-visibility";

export async function GET(
  request: Request,
  context: { params: Promise<{ rfpId: string }> },
) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { rfpId } = await context.params;
  const [profile, rfpRow] = await Promise.all([
    getFullProfile(auth.userId),
    db
      .select()
      .from(rfpCache)
      .where(and(eq(rfpCache.id, rfpId), visibleRfpSourceClause()))
      .limit(1),
  ]);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }
  if (rfpRow.length === 0) {
    return NextResponse.json({ error: "RFP not found" }, { status: 404 });
  }

  const rfp = rfpRow[0];
  const m = matchV2(profile, rfp);

  // The richer fields (contact, eventUrl, attachments, evaluation criteria,
  // contract duration, attachment_rollup) live in rfp_cache.raw — the
  // populator stores the full V2EnrichedEvent there. Pull them out so the
  // detail page can render contact info and feed the LLM summary endpoints
  // with the same shape /api/events uses.
  const raw = (rfp.raw ?? {}) as Record<string, unknown>;
  const contact = (raw.contact ?? {}) as { name?: string; email?: string; phone?: string };

  return NextResponse.json(
    {
      rfp: {
        id: rfp.id,
        title: rfp.title,
        description: rfp.description,
        agency: rfp.agency,
        location: rfp.location,
        deadline: rfp.deadline,
        sourceId: rfp.sourceId,
        estimatedValueUsd: rfp.estimatedValueUsd,
        // Typed cache columns
        capabilities: rfp.capabilities ?? [],
        naicsCodes: rfp.naicsCodes ?? [],
        certificationsRequired: rfp.certificationsRequired ?? [],
        licensesRequired: rfp.licensesRequired ?? [],
        setAsideTypes: rfp.setAsideLockout ?? [],
        deliverables: rfp.deliverables ?? [],
        incumbentVendor: rfp.incumbentVendor,
        incumbentContractEnd: rfp.incumbentContractEnd,
        // Raw payload extras (populator writes the full V2EnrichedEvent)
        industry: raw.industry ?? null,
        contractType: raw.procurement_type ?? null,
        contractDuration: raw.contract_duration ?? null,
        evaluationCriteria: Array.isArray(raw.evaluation_criteria)
          ? (raw.evaluation_criteria as string[])
          : [],
        clearancesRequired: Array.isArray(raw.clearances_required)
          ? (raw.clearances_required as string[])
          : [],
        attachmentUrls: Array.isArray(raw.attachment_urls)
          ? (raw.attachment_urls as string[])
          : [],
        mirroredAttachments: Array.isArray(raw.mirrored_attachments)
          ? (raw.mirrored_attachments as Array<{ filename?: string; s3_key?: string; original_url?: string | null }>)
              .filter((m) => m && typeof m.s3_key === "string" && typeof m.filename === "string")
              .map((m) => ({
                filename: m.filename!,
                s3Key: m.s3_key!,
                originalUrl: m.original_url ?? null,
              }))
          : [],
        attachmentRollup: raw.attachment_rollup ?? null,
        eventUrl: raw.source_url ?? null,
        contactName: contact.name ?? null,
        contactEmail: contact.email ?? null,
        contactPhone: contact.phone ?? null,
      },
      score: m.score,
      winProbability: m.winProbability,
      tier: m.tier,
      primeEligible: m.primeEligible,
      subEligible: m.subEligible,
      gateFailures: m.gateFailures,
      incumbent: m.incumbent,
      dataQuality: m.dataQuality,
      breakdown: m.breakdown,
      subTrack: m.subTrack,
    },
    { headers: { "Cache-Control": "private, max-age=30" } },
  );
}
