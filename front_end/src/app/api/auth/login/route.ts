// Login — Postgres-backed (Architecture-v2 § 11).

import { NextResponse } from "next/server";
import { verifyPassword, signJwt, setAuthCookie } from "@/lib/auth";
import { getUserByUsername } from "@/db/queries/users";
import { logSecurityEvent } from "@/lib/security-log";
import { recordEvent } from "@/lib/event-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// 5 login attempts per 15 minutes per IP
const AUTH_MAX_REQUESTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(ip, AUTH_MAX_REQUESTS, AUTH_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) },
      },
    );
  }

  try {
    const body = await request.json();
    const username = (body.username || "").trim();
    const password = body.password || "";

    if (!username || !password) {
      return NextResponse.json(
        { error: "username and password required" },
        { status: 400 },
      );
    }

    const user = await getUserByUsername(username);
    if (!user) {
      // Constant-time-ish: don't leak whether the username exists.
      // bcrypt.compare against a dummy hash would be more strictly constant,
      // but the rate limiter mitigates the timing-oracle risk in practice.
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const authenticated = await verifyPassword(password, user.passwordHash);
    if (!authenticated) {
      logSecurityEvent({
        type: "login_failure",
        username,
        ip: request.headers.get("x-forwarded-for") || undefined,
      });
      void recordEvent(username, "login_failure");
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const token = await signJwt(user.id, user.username);
    const response = NextResponse.json(
      { username: user.username },
      { headers: { "Cache-Control": "no-store" } },
    );
    setAuthCookie(response, token);
    logSecurityEvent({
      type: "login_success",
      username,
      ip: request.headers.get("x-forwarded-for") || undefined,
    });
    void recordEvent(username, "login");
    return response;
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
