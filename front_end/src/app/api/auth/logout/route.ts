import { NextResponse } from "next/server";

export async function POST() {
  // With JWT auth, logout is client-side (discard token).
  // Server-side is a no-op returning 204.
  return new NextResponse(null, { status: 204 });
}
