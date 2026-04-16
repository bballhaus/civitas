import { NextResponse } from "next/server";
import { getUserData, saveUserData } from "@/lib/user-data";
import { checkEmailUniqueness } from "@/lib/email-index";
import { logSecurityEvent } from "@/lib/security-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// 3 reset requests per 15 minutes per IP
const RESET_MAX = 3;
const RESET_WINDOW = 15 * 60 * 1000;

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(ip, RESET_MAX, RESET_WINDOW);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
    );
  }

  try {
    const body = await request.json();
    const email = (body.email || "").trim().toLowerCase();

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    // Always return success to prevent email enumeration
    const successMsg = "If an account with that email exists, a reset link has been sent.";

    const username = await checkEmailUniqueness(email);
    if (!username) {
      return NextResponse.json({ message: successMsg });
    }

    const data = await getUserData(username);
    if (!data) {
      return NextResponse.json({ message: successMsg });
    }

    // Generate reset token with 1-hour expiry
    const resetToken = crypto.randomUUID();
    data.password_reset_token = resetToken;
    data.password_reset_expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await saveUserData(username, data);

    // In dev, log the reset URL; in prod, you'd send an email via SES
    const host = request.headers.get("host") || "localhost:3000";
    const proto = request.headers.get("x-forwarded-proto") || "http";
    const resetUrl = `${proto}://${host}/reset-password?token=${resetToken}&username=${encodeURIComponent(username)}`;
    console.log(`[Password Reset] ${resetUrl}`);

    logSecurityEvent({ type: "password_reset_request", username, ip });

    return NextResponse.json({ message: successMsg });
  } catch (err) {
    console.error("Forgot password error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
