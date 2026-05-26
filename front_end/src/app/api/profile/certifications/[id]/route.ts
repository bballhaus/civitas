// Remove a certification by id, scoped to the authenticated user.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { removeCertification } from "@/db/queries/profile";
import { triggerProfileChangedRescore } from "@/lib/match-rescore-trigger";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const removed = await removeCertification(auth.userId, id);
  if (!removed) {
    return NextResponse.json({ error: "Certification not found" }, { status: 404 });
  }
  await triggerProfileChangedRescore(auth.userId);
  return new NextResponse(null, { status: 204 });
}
