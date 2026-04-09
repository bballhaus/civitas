import { NextResponse } from "next/server";
import { hashPassword, validatePassword, signJwt } from "@/lib/auth";
import { getUserData, saveUserData, userExists, type UserData } from "@/lib/user-data";
import { getOrCreateProfile } from "@/lib/profile-storage";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const username = (body.username || "").trim();
    const password = body.password || "";
    const email = (body.email || "").trim();

    if (!username || !password) {
      return NextResponse.json(
        { error: "Username and password are required." },
        { status: 400 }
      );
    }

    if (!email) {
      return NextResponse.json(
        { error: "Email is required." },
        { status: 400 }
      );
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    // Check username uniqueness
    if (await userExists(username)) {
      return NextResponse.json(
        { error: "A user with that username already exists." },
        { status: 400 }
      );
    }

    // Create user
    const passwordHash = await hashPassword(password);
    const userData: UserData = {
      password_hash: passwordHash,
      email,
      applied_rfp_ids: [],
      in_progress_rfp_ids: [],
      generated_poe_by_rfp: {},
      generated_proposal_by_rfp: {},
    };
    await saveUserData(username, userData);

    // Create default profile
    await getOrCreateProfile(username);

    // Sign JWT
    const token = await signJwt(username);

    return NextResponse.json(
      { username, token },
      { status: 201 }
    );
  } catch (err) {
    console.error("Signup error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
