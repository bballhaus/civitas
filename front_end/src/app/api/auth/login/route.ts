import { NextResponse } from "next/server";
import {
  verifyPassword,
  verifyDjangoPbkdf2,
  hashPassword,
  signJwt,
} from "@/lib/auth";
import { getUserData, saveUserData } from "@/lib/user-data";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const username = (body.username || "").trim();
    const password = body.password || "";

    if (!username || !password) {
      return NextResponse.json(
        { error: "username and password required" },
        { status: 400 }
      );
    }

    const data = await getUserData(username);
    if (!data) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    let authenticated = false;

    // Try bcrypt hash first (normal path)
    if (data.password_hash) {
      authenticated = await verifyPassword(password, data.password_hash);
    }

    // Fall back to Django PBKDF2 for migrated users
    if (!authenticated && data.password_hash_legacy) {
      authenticated = await verifyDjangoPbkdf2(password, data.password_hash_legacy);
      if (authenticated) {
        // Transparent migration: re-hash with bcrypt and remove legacy hash
        data.password_hash = await hashPassword(password);
        delete data.password_hash_legacy;
        await saveUserData(username, data);
      }
    }

    if (!authenticated) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    const token = await signJwt(username);
    return NextResponse.json(
      { username, token },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
