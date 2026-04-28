// Add a specialty to the current user's profile.
// (Architecture-v2 § 11)

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { addSpecialty } from "@/db/queries/profile";

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const value = (body.value || "").trim();
    const weight = body.weight;
    const canonicalId = body.canonicalId ?? body.canonical_id ?? null;

    if (!value) {
      return NextResponse.json({ error: "value is required" }, { status: 400 });
    }
    if (weight && weight !== "primary" && weight !== "secondary") {
      return NextResponse.json(
        { error: "weight must be 'primary' or 'secondary'" },
        { status: 400 },
      );
    }

    const row = await addSpecialty({
      userId: auth.userId,
      value,
      weight: weight ?? "primary",
      canonicalId,
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error("Add specialty error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
