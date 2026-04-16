import { NextResponse } from "next/server";
import {
  getAuthenticatedUser,
  verifyPassword,
  validatePassword,
  hashPassword,
} from "@/lib/auth";
import { getUserData, saveUserData } from "@/lib/user-data";
import { logSecurityEvent } from "@/lib/security-log";

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const currentPassword = body.current_password || "";
    const newPassword = body.new_password || "";

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: "Current password and new password are required." },
        { status: 400 }
      );
    }

    const data = await getUserData(user.username);
    if (!data?.password_hash) {
      return NextResponse.json(
        { error: "User data not found" },
        { status: 404 }
      );
    }

    const valid = await verifyPassword(currentPassword, data.password_hash);
    if (!valid) {
      return NextResponse.json(
        { error: "Current password is incorrect." },
        { status: 400 }
      );
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    data.password_hash = await hashPassword(newPassword);
    await saveUserData(user.username, data);

    logSecurityEvent({ type: "password_change", username: user.username, ip: request.headers.get("x-forwarded-for") || undefined });

    return NextResponse.json({ message: "Password changed successfully." });
  } catch (err) {
    console.error("Change password error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
