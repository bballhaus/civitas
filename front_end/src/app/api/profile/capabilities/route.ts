// Add a capability to the current user's profile.
// (Architecture-v2 § 11)

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { addCapability } from "@/db/queries/profile";

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const value = (body.value || "").trim();
    const canonicalId = body.canonicalId ?? body.canonical_id ?? null;

    if (!value) {
      return NextResponse.json({ error: "value is required" }, { status: 400 });
    }

    const row = await addCapability({ userId: auth.userId, value, canonicalId });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error("Add capability error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
