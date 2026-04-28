import { NextResponse } from "next/server";
import { clearAuthCookie, getAuthenticatedUser } from "@/lib/auth";
import { recordEvent } from "@/lib/event-log";

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (user?.username) {
    void recordEvent(user.username, "logout");
  }
  const response = new NextResponse(null, { status: 204 });
  clearAuthCookie(response);
  return response;
}
