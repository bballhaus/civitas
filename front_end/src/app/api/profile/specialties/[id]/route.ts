// Remove a specialty by id. Scoped to the authenticated user — attempting
// to delete another user's row returns 404, not 403, to avoid leaking
// existence.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { removeSpecialty } from "@/db/queries/profile";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const removed = await removeSpecialty(auth.userId, id);
  if (!removed) {
    return NextResponse.json({ error: "Specialty not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
