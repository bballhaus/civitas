// Remove an agency relationship by id, scoped to the authenticated user.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { removeAgencyRelationship } from "@/db/queries/profile";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const removed = await removeAgencyRelationship(auth.userId, id);
  if (!removed) {
    return NextResponse.json(
      { error: "Agency relationship not found" },
      { status: 404 },
    );
  }
  return new NextResponse(null, { status: 204 });
}
