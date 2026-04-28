// Add an agency relationship (prime or sub experience with an agency).
// The matcher rewards prior agency experience separately from generic
// agency-name token matching (Architecture-v2 § 9.5).

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { addAgencyRelationship } from "@/db/queries/profile";

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const agencyCanonical = (body.agencyCanonical || body.agency_canonical || "").trim();
    const agencyDisplay = (body.agencyDisplay || body.agency_display || "").trim();
    const role = body.role;
    const contractCount = Number(body.contractCount ?? body.contract_count ?? 1);
    const lastContractAt = body.lastContractAt ?? body.last_contract_at ?? undefined;
    const strengthRaw = body.strength;
    const source = body.source ?? "user";

    if (!agencyCanonical) {
      return NextResponse.json(
        { error: "agencyCanonical is required" },
        { status: 400 },
      );
    }
    if (!agencyDisplay) {
      return NextResponse.json(
        { error: "agencyDisplay is required" },
        { status: 400 },
      );
    }
    if (role !== "prime" && role !== "sub") {
      return NextResponse.json(
        { error: "role must be 'prime' or 'sub'" },
        { status: 400 },
      );
    }
    const strength = strengthRaw == null ? 1 : Number(strengthRaw);
    if (!Number.isInteger(strength) || strength < 1 || strength > 5) {
      return NextResponse.json(
        { error: "strength must be an integer 1-5" },
        { status: 400 },
      );
    }
    if (
      source !== "user" &&
      source !== "vendor_fingerprint" &&
      source !== "extraction"
    ) {
      return NextResponse.json(
        { error: "source must be 'user', 'vendor_fingerprint', or 'extraction'" },
        { status: 400 },
      );
    }

    const row = await addAgencyRelationship({
      userId: auth.userId,
      agencyCanonical,
      agencyDisplay,
      role,
      contractCount,
      lastContractAt,
      strength,
      source,
    });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error("Add agency relationship error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
