// Change password — Postgres-backed (Architecture-v2 § 11).

import { NextResponse } from "next/server";
import {
  getAuthenticatedUser,
  verifyPassword,
  validatePassword,
  hashPassword,
} from "@/lib/auth";
import { getUserById, updatePasswordHash } from "@/db/queries/users";
import { logSecurityEvent } from "@/lib/security-log";
import { recordEvent } from "@/lib/event-log";

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const currentPassword = body.current_password || "";
    const newPassword = body.new_password || "";

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: "Current password and new password are required." },
        { status: 400 },
      );
    }

    const user = await getUserById(auth.userId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      return NextResponse.json(
        { error: "Current password is incorrect." },
        { status: 400 },
      );
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    await updatePasswordHash(user.id, await hashPassword(newPassword));

    logSecurityEvent({
      type: "password_change",
      username: user.username,
      ip: request.headers.get("x-forwarded-for") || undefined,
    });
    void recordEvent(user.username, "password_change");

    return NextResponse.json({ message: "Password changed successfully." });
  } catch (err) {
    console.error("Change password error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
