// Signup — email-verify-before-account-creation flow.
//
// The user submits the signup form, we write to `pending_users` (NOT `users`)
// and send a verification email. No auth cookie is set. The account only
// becomes real when the user clicks the verification link, at which point
// the verify-email route promotes the pending row into `users`.
//
// This closes the gap from Security.md where signup created a real user
// before email ownership was proven.
//
// Feature flag: set env var SKIP_EMAIL_VERIFICATION=true to bypass the
// pending_users + email flow entirely and create the account immediately.
// Intended for use while SES is in sandbox and individual recipient
// verification is too slow for testing — flip back to default once SES
// production access lands.

import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { hashPassword, validatePassword, signJwt, setAuthCookie } from "@/lib/auth";
import { createUser, getUserByUsername, getUserByEmail } from "@/db/queries/users";
import { setEmailVerified } from "@/db/queries/users";
import { upsertPendingUser } from "@/db/queries/pending-users";
import { sendVerificationEmail } from "@/lib/email";
import { logSecurityEvent } from "@/lib/security-log";
import { recordEvent } from "@/lib/event-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const SIGNUP_MAX_REQUESTS = 5;
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function emailVerificationBypassed(): boolean {
  return process.env.SKIP_EMAIL_VERIFICATION === "true";
}

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
    const username = (body.username || "").trim().toLowerCase();
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

    // KPI funnel stage 1: form passed validation + uniqueness checks. Keyed
    // on the prospective username (matches the username stored in
    // pending_users and later promoted into users) so the whole funnel
    // joins on the same id.
    void recordEvent(username, "signup_form_submitted");

    const passwordHash = await hashPassword(password);

    // ---- Bypass branch ----
    // Create the user immediately, mark verified, set the auth cookie, and
    // return the same shape the v2 main flow returns so the client can
    // redirect into /onboarding. KPI events still fire for the funnel; we
    // mark `verificationBypassed: true` on `signup` so downstream queries
    // can distinguish bypassed accounts from email-verified ones.
    if (emailVerificationBypassed()) {
      const user = await createUser({ username, email, passwordHash });
      await setEmailVerified(user.id);
      const token = await signJwt(user.id, user.username);

      logSecurityEvent({
        type: "signup",
        username,
        ip: request.headers.get("x-forwarded-for") || undefined,
        details: "email_verification_bypassed",
      });
      void recordEvent(user.username, "signup", {
        verificationBypassed: true,
        emailVerified: true,
      });

      const response = NextResponse.json(
        {
          username: user.username,
          email: user.email,
          email_verified: true,
          bypassed: true,
        },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
      setAuthCookie(response, token);
      return response;
    }

    // ---- Default branch (email-verify-before-create) ----
    const verificationToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

    await upsertPendingUser({
      username,
      email,
      passwordHash,
      verificationToken,
      expiresAt,
    });

    const host = request.headers.get("host") || "localhost:3000";
    const proto = request.headers.get("x-forwarded-proto") || "http";
    const emailSent = await sendVerificationEmail(
      email,
      username,
      verificationToken,
      host,
      proto,
    );

    logSecurityEvent({
      type: "signup_verification_sent",
      username,
      ip: request.headers.get("x-forwarded-for") || undefined,
    });
    // KPI funnel stage 2: SES called (success-or-fallback) and pending row
    // exists. `emailSent=false` means CIVITAS_FROM_EMAIL wasn't set so the
    // helper logged to console — still record the event so we can see the
    // gap between sends and SES-actual-delivery downstream.
    void recordEvent(username, "signup_verification_sent", { emailSent });

    return NextResponse.json(
      {
        pending: true,
        email,
        emailSent,
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("Signup error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
