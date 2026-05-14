// PATCH /api/contracts/{id}/claims/{claimId}/ — accept | reject | edit.
// Architecture-v2 § 6.5: this is the gate between extraction and any
// write to the profile tables. The extractor never touches the profile
// directly.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { acceptClaim, rejectClaim, editAndAcceptClaim } from "@/lib/claim-acceptance";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; claimId: string }> },
) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { claimId } = await context.params;
  const body = (await request.json()) as { action?: string; value?: string };
  const action = body.action;

  try {
    if (action === "accept") {
      await acceptClaim(claimId, auth.userId);
    } else if (action === "reject") {
      await rejectClaim(claimId, auth.userId);
    } else if (action === "edit") {
      if (typeof body.value !== "string" || !body.value.trim()) {
        return NextResponse.json({ error: "value required for edit" }, { status: 400 });
      }
      await editAndAcceptClaim(claimId, auth.userId, body.value.trim());
    } else {
      return NextResponse.json(
        { error: "action must be 'accept' | 'reject' | 'edit'" },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[claims/patch] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
