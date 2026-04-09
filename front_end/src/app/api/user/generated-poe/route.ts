import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getGeneratedPoe } from "@/lib/rfp-status";

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const rfpId = searchParams.get("rfp_id");

  if (!rfpId) {
    return NextResponse.json({ error: "rfp_id is required" }, { status: 400 });
  }

  const content = await getGeneratedPoe(user.username, rfpId);
  return NextResponse.json({ plan_of_execution: content });
}
