// Add a certification (hard or soft) to the current user's profile.
// Hard certs gate the matcher; soft certs are bonus signals (Architecture-v2 § 9.2).

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { addCertification } from "@/db/queries/profile";

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const canonicalId = (body.canonicalId || body.canonical_id || "").trim();
    const displayName = (body.displayName || body.display_name || "").trim();
    const kind = body.kind;
    const expiresOn = body.expiresOn || body.expires_on || undefined;

    if (!canonicalId) {
      return NextResponse.json(
        { error: "canonicalId is required" },
        { status: 400 },
      );
    }
    if (!displayName) {
      return NextResponse.json(
        { error: "displayName is required" },
        { status: 400 },
      );
    }
    if (kind !== "hard" && kind !== "soft") {
      return NextResponse.json(
        { error: "kind must be 'hard' or 'soft'" },
        { status: 400 },
      );
    }

    const row = await addCertification({
      userId: auth.userId,
      canonicalId,
      displayName,
      kind,
      expiresOn,
    });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error("Add certification error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
