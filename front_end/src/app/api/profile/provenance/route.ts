// GET /api/profile/provenance/ — Architecture-v2 § 12.
//
// Returns the list of accepted claims grouped by field_path + value so the
// /profile/v2 page can render "Cloud Services — from contract X" markers
// next to each specialty / capability / license / etc.
//
// Cheap: single grouped query against claims joined to contracts, scoped
// to the current user. We don't pre-aggregate by field_path here — the
// client does the bucketing so it doesn't have to round-trip on resort.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { claims, contracts } from "@/db/schema";

export async function GET(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const rows = await db
    .select({
      fieldPath: claims.fieldPath,
      value: claims.value,
      snippet: claims.snippet,
      confidence: claims.confidence,
      decidedAt: claims.decidedAt,
      contractId: contracts.id,
      filename: contracts.originalFilename,
      documentType: contracts.documentType,
      contractStatus: contracts.contractStatus,
    })
    .from(claims)
    .leftJoin(contracts, eq(contracts.id, claims.contractId))
    .where(and(eq(claims.userId, auth.userId), eq(claims.status, "accepted")));

  return NextResponse.json(
    { provenance: rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}
