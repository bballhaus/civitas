import { NextResponse } from "next/server";
import { hashPassword, validatePassword, signJwt, setAuthCookie } from "@/lib/auth";
import { getUserData, saveUserData, userExists, type UserData } from "@/lib/user-data";
import { getOrCreateProfile } from "@/lib/profile-storage";
import { logSecurityEvent } from "@/lib/security-log";
import { checkEmailUniqueness, registerEmail } from "@/lib/email-index";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { sendVerificationEmail } from "@/lib/email";

// 5 signup attempts per 15 minutes per IP
const SIGNUP_MAX_REQUESTS = 5;
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  // Rate limiting
  const ip = getClientIp(request);
  const rl = checkRateLimit(ip, SIGNUP_MAX_REQUESTS, SIGNUP_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many signup attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
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

    // Check email uniqueness
    const emailOwner = await checkEmailUniqueness(email);
    if (emailOwner) {
      return NextResponse.json(
        { error: "An account with that email already exists." },
        { status: 400 }
      );
    }

    // Auto-verify in development, require verification in production
    const isDev = process.env.NODE_ENV === "development";
    const emailVerified = isDev;
    const verificationToken = isDev ? undefined : crypto.randomUUID();

    // Create user
    const passwordHash = await hashPassword(password);
    const userData: UserData = {
      password_hash: passwordHash,
      email,
      email_verified: emailVerified,
      email_verification_token: verificationToken,
      applied_rfp_ids: [],
      in_progress_rfp_ids: [],
      generated_poe_by_rfp: {},
      generated_proposal_by_rfp: {},
    };
    await saveUserData(username, userData);

    // Register email in index
    await registerEmail(email, username);

    // Create default profile
    await getOrCreateProfile(username);

    // Sign JWT
    const token = await signJwt(username);

    // Send verification email (in dev without SES, falls back to console logging)
    if (!isDev && verificationToken) {
      const host = request.headers.get("host") || "localhost:3000";
      const proto = request.headers.get("x-forwarded-proto") || "https";
      await sendVerificationEmail(email, username, verificationToken, host, proto);
    }

    logSecurityEvent({ type: "signup", username, ip: request.headers.get("x-forwarded-for") || undefined });

    const response = NextResponse.json(
      { username, email_verified: emailVerified },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
    setAuthCookie(response, token);
    return response;
  } catch (err) {
    console.error("Signup error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
