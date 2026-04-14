import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { refreshProfileFromContracts } from "@/lib/profile-storage";

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const profile = await refreshProfileFromContracts(user.username);
  return NextResponse.json(profile);
}
