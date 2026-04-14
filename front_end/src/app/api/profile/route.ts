import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getOrCreateProfile, getProfile, saveProfile } from "@/lib/profile-storage";

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const profile = await getOrCreateProfile(user.username);
  return NextResponse.json(profile);
}

export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const updates = await request.json();
    const existing = await getOrCreateProfile(user.username);

    // Merge updates into existing profile
    const merged = { ...existing, ...updates, updated_at: new Date().toISOString() };

    await saveProfile(user.username, merged);
    return NextResponse.json(merged);
  } catch (err) {
    console.error("Profile update error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
