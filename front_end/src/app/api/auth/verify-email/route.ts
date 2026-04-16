import { NextResponse } from "next/server";
import { getUserData, saveUserData } from "@/lib/user-data";
import { logSecurityEvent } from "@/lib/security-log";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  const username = searchParams.get("username");

  if (!token || !username) {
    return NextResponse.json({ error: "Missing token or username" }, { status: 400 });
  }

  const data = await getUserData(username);
  if (!data) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (data.email_verified) {
    // Already verified — redirect to login
    return NextResponse.redirect(new URL("/login?verified=1", request.url));
  }

  if (data.email_verification_token !== token) {
    return NextResponse.json({ error: "Invalid verification token" }, { status: 400 });
  }

  data.email_verified = true;
  delete data.email_verification_token;
  await saveUserData(username, data);

  logSecurityEvent({ type: "email_verified", username });

  return NextResponse.redirect(new URL("/login?verified=1", request.url));
}
