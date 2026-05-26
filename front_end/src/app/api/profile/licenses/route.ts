// Add a license to the current user's profile.
// License class is the binary key the matcher uses (CSLB Class A, C-12,
// PE, DIR, ...). Per § 9.2 it acts as a hard gate when the RFP specifies
// a license, so storing it as a typed value (not free-text) matters.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { addLicense } from "@/db/queries/profile";
import { triggerProfileChangedRescore } from "@/lib/match-rescore-trigger";

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const licenseClass = (body.licenseClass || body.license_class || "").trim();
    const licenseNumber = (body.licenseNumber || body.license_number || "").trim() || undefined;
    const expiresOn = body.expiresOn || body.expires_on || undefined;
    const verified = body.verified === true;

    if (!licenseClass) {
      return NextResponse.json(
        { error: "licenseClass is required" },
        { status: 400 },
      );
    }

    const row = await addLicense({
      userId: auth.userId,
      licenseClass,
      licenseNumber,
      expiresOn,
      verified,
    });
    await triggerProfileChangedRescore(auth.userId);
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error("Add license error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
