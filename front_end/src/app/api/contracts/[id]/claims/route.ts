// GET /api/contracts/{id}/claims/ — list claims for the contract review
// screen (Architecture-v2 § 6.5). Grouped by field_path on the client.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { claims, contracts } from "@/db/schema";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await context.params;

  // Confirm the contract belongs to this user before exposing claims.
  const [contract] = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.id, id), eq(contracts.userId, auth.userId)))
    .limit(1);
  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(claims)
    .where(and(eq(claims.contractId, id), eq(claims.userId, auth.userId)));

  return NextResponse.json(
    {
      contract: {
        id: contract.id,
        documentType: contract.documentType,
        contractStatus: contract.contractStatus,
        originalFilename: contract.originalFilename,
        piiRedactedCount: contract.piiRedactedCount,
        extractedAt: contract.extractedAt,
      },
      claims: rows.map((c) => ({
        id: c.id,
        fieldPath: c.fieldPath,
        value: c.value,
        snippet: c.snippet,
        confidence: c.confidence,
        status: c.status,
        decidedAt: c.decidedAt,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
