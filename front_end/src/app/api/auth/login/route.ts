import { NextResponse } from "next/server";
import {
  verifyPassword,
  verifyDjangoPbkdf2,
  hashPassword,
  signJwt,
  setAuthCookie,
} from "@/lib/auth";
import { logSecurityEvent } from "@/lib/security-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getUserData, saveUserData } from "@/lib/user-data";

// 5 login attempts per 15 minutes per IP
const AUTH_MAX_REQUESTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  // Rate limiting
  const ip = getClientIp(request);
  const rl = checkRateLimit(ip, AUTH_MAX_REQUESTS, AUTH_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
    );
  }

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
      logSecurityEvent({ type: "login_failure", username, ip: request.headers.get("x-forwarded-for") || undefined });
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    const token = await signJwt(username);
    const response = NextResponse.json(
      { username },
      { headers: { "Cache-Control": "no-store" } }
    );
    setAuthCookie(response, token);
    logSecurityEvent({ type: "login_success", username, ip: request.headers.get("x-forwarded-for") || undefined });
    return response;
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
