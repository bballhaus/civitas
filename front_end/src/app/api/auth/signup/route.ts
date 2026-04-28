// Signup — Postgres-backed (matching-alg / Architecture-v2 § 11).
//
// Creates the user + an empty profile in a single transaction (see
// db/queries/users.ts). Email verification token flow is deferred until the
// schema gains the verification token columns; for now we auto-verify in
// dev and skip the email send in prod (signup still works, the user just
// won't have a verified email until that feature is rebuilt).

import { NextResponse } from "next/server";
import { hashPassword, validatePassword, signJwt, setAuthCookie } from "@/lib/auth";
import { createUser, getUserByUsername, getUserByEmail } from "@/db/queries/users";
import { logSecurityEvent } from "@/lib/security-log";
import { recordEvent } from "@/lib/event-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// 5 signup attempts per 15 minutes per IP
const SIGNUP_MAX_REQUESTS = 5;
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(ip, SIGNUP_MAX_REQUESTS, SIGNUP_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many signup attempts. Please try again later." },
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
    const email = (body.email || "").trim();

    if (!username || !password) {
      return NextResponse.json(
        { error: "Username and password are required." },
        { status: 400 },
      );
    }
    if (!email) {
      return NextResponse.json({ error: "Email is required." }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 },
      );
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    if (await getUserByUsername(username)) {
      return NextResponse.json(
        { error: "A user with that username already exists." },
        { status: 400 },
      );
    }
    if (await getUserByEmail(email)) {
      return NextResponse.json(
        { error: "An account with that email already exists." },
        { status: 400 },
      );
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser({ username, email, passwordHash });

    // Email verification token flow is being rebuilt against the new schema.
    // For now: verified-by-default in dev, unverified in prod (user can still
    // sign in; verified flag will be flipped via a separate flow once the
    // token columns and email send paths land).
    // TODO: add email_verification_token + email_verification_expires_at
    // columns to the users table and re-enable token-based verification.

    const token = await signJwt(user.id, user.username);

    logSecurityEvent({
      type: "signup",
      username,
      ip: request.headers.get("x-forwarded-for") || undefined,
    });
    void recordEvent(user.username, "signup", { emailVerified: user.emailVerified });

    const response = NextResponse.json(
      { username: user.username, email_verified: user.emailVerified },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
    setAuthCookie(response, token);
    return response;
  } catch (err) {
    console.error("Signup error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
