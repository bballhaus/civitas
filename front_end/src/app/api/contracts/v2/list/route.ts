// GET /api/contracts/v2/list/ — list the current user's contracts with
// per-contract claim counts for the /contracts dashboard.

import { NextResponse } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { contracts, claims } from "@/db/schema";

export async function GET(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  // One query per state via aggregate counts. Could be one query with a
  // single GROUP BY if we want to optimize later; the catalog is small.
  const rows = await db
    .select({
      id: contracts.id,
      documentType: contracts.documentType,
      contractStatus: contracts.contractStatus,
      originalFilename: contracts.originalFilename,
      extractedAt: contracts.extractedAt,
      piiRedactedCount: contracts.piiRedactedCount,
    })
    .from(contracts)
    .where(eq(contracts.userId, auth.userId))
    .orderBy(sql`${contracts.createdAt} desc`);

  // Fetch claim counts in a single grouped query.
  const counts = await db
    .select({
      contractId: claims.contractId,
      status: claims.status,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(claims)
    .where(eq(claims.userId, auth.userId))
    .groupBy(claims.contractId, claims.status);

  const countMap = new Map<string, { pending: number; accepted: number; rejected: number }>();
  for (const c of counts) {
    if (!c.contractId) continue;
    const entry = countMap.get(c.contractId) ?? { pending: 0, accepted: 0, rejected: 0 };
    if (c.status === "pending") entry.pending = Number(c.count);
    else if (c.status === "accepted") entry.accepted = Number(c.count);
    else if (c.status === "rejected") entry.rejected = Number(c.count);
    countMap.set(c.contractId, entry);
  }

  return NextResponse.json(
    {
      contracts: rows.map((r) => {
        const cc = countMap.get(r.id);
        return {
          ...r,
          pendingClaims: cc?.pending ?? 0,
          acceptedClaims: cc?.accepted ?? 0,
        };
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
