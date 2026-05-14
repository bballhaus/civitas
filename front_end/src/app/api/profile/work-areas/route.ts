// Add a work area (city / county / metro / state) to the current user's
// profile. The is_hard flag indicates "won't travel outside" — used as a
// hard gate in the matcher (Architecture-v2 § 9.2).

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { addWorkArea } from "@/db/queries/profile";

const ALLOWED_KINDS = new Set(["city", "county", "metro", "state"]);

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const kind = (body.kind || "").trim();
    const name = (body.name || "").trim();
    const isHard = body.isHard === true || body.is_hard === true;
    const radiusRaw = body.radiusMiles ?? body.radius_miles;
    const radiusMiles =
      radiusRaw == null || radiusRaw === "" ? null : Number(radiusRaw);

    if (!ALLOWED_KINDS.has(kind)) {
      return NextResponse.json(
        { error: "kind must be one of: city, county, metro, state" },
        { status: 400 },
      );
    }
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (radiusMiles != null && (Number.isNaN(radiusMiles) || radiusMiles < 0)) {
      return NextResponse.json(
        { error: "radiusMiles must be a non-negative number" },
        { status: 400 },
      );
    }

    const row = await addWorkArea({
      userId: auth.userId,
      kind: kind as "city" | "county" | "metro" | "state",
      name,
      isHard,
      radiusMiles,
    });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error("Add work area error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
