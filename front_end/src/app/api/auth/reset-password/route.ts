import { NextResponse } from "next/server";
import { hashPassword, validatePassword } from "@/lib/auth";
import { getUserData, saveUserData } from "@/lib/user-data";
import { logSecurityEvent } from "@/lib/security-log";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const token = (body.token || "").trim();
    const username = (body.username || "").trim();
    const newPassword = body.new_password || "";

    if (!token || !username || !newPassword) {
      return NextResponse.json(
        { error: "Token, username, and new password are required." },
        { status: 400 }
      );
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const data = await getUserData(username);
    if (!data) {
      return NextResponse.json({ error: "Invalid reset link." }, { status: 400 });
    }

    if (!data.password_reset_token || data.password_reset_token !== token) {
      return NextResponse.json({ error: "Invalid or expired reset link." }, { status: 400 });
    }

    if (data.password_reset_expires && new Date(data.password_reset_expires) < new Date()) {
      return NextResponse.json({ error: "Reset link has expired. Please request a new one." }, { status: 400 });
    }

    // Update password and clear reset token
    data.password_hash = await hashPassword(newPassword);
    delete data.password_reset_token;
    delete data.password_reset_expires;
    await saveUserData(username, data);

    logSecurityEvent({
      type: "password_reset_complete",
      username,
      ip: request.headers.get("x-forwarded-for") || undefined,
    });

    return NextResponse.json({ message: "Password has been reset. You can now log in." });
  } catch (err) {
    console.error("Reset password error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
