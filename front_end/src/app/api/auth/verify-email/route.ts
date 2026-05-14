// Verify email — Postgres-backed.
//
// Validates the token against `pending_users`, promotes the row into `users`
// (with an empty `profiles` row), sets the auth cookie, and redirects.
//
// This is where a Civitas account actually comes into existence. Until this
// endpoint runs, the user only exists as a `pending_users` row.

import { NextResponse } from "next/server";
import {
  getPendingUserByToken,
  promotePendingUser,
} from "@/db/queries/pending-users";
import { getUserByEmail, getUserByUsername } from "@/db/queries/users";
import { signJwt, setAuthCookie } from "@/lib/auth";
import { logSecurityEvent } from "@/lib/security-log";
import { recordEvent } from "@/lib/event-log";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(
      new URL("/login?verify_error=missing_token", request.url),
    );
  }

  const pending = await getPendingUserByToken(token);
  if (!pending) {
    return NextResponse.redirect(
      new URL("/login?verify_error=invalid_token", request.url),
    );
  }

  if (pending.expiresAt.getTime() < Date.now()) {
    return NextResponse.redirect(
      new URL("/login?verify_error=expired", request.url),
    );
  }

  // Race-condition guard: someone else may have grabbed the same username or
  // email between signup and verification (unlikely with unique indexes, but
  // possible if a different pending row was promoted first).
  if (await getUserByUsername(pending.username)) {
    return NextResponse.redirect(
      new URL("/login?verify_error=username_taken", request.url),
    );
  }
  if (await getUserByEmail(pending.email)) {
    return NextResponse.redirect(
      new URL("/login?verify_error=email_taken", request.url),
    );
  }

  const user = await promotePendingUser(pending);

  const jwt = await signJwt(user.id, user.username);

  logSecurityEvent({ type: "signup", username: user.username });
  logSecurityEvent({ type: "email_verified", username: user.username });
  void recordEvent(user.username, "signup", { emailVerified: true });
  void recordEvent(user.username, "email_verified");

  const response = NextResponse.redirect(new URL("/upload", request.url));
  setAuthCookie(response, jwt);
  return response;
}
