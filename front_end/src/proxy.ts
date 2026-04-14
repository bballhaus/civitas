import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy: rate limiting for auth and extraction endpoints.
 *
 * Runs at the edge before API route handlers. Protects against
 * brute-force login/signup attempts and abuse of expensive
 * LLM-powered extraction endpoints.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Auth endpoints: 10 requests per minute
const AUTH_RATE_LIMIT = 10;
const AUTH_WINDOW_MS = 60 * 1000;

// Profile extract (public, expensive): 5 requests per minute
const EXTRACT_RATE_LIMIT = 5;
const EXTRACT_WINDOW_MS = 60 * 1000;

function getIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

function isRateLimited(
  ip: string,
  prefix: string,
  limit: number,
  windowMs: number
): { limited: boolean; remaining: number; retryAfterMs: number } {
  const key = `${prefix}:${ip}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, remaining: limit - 1, retryAfterMs: 0 };
  }

  if (entry.count >= limit) {
    return { limited: true, remaining: 0, retryAfterMs: entry.resetAt - now };
  }

  entry.count++;
  return { limited: false, remaining: limit - entry.count, retryAfterMs: 0 };
}

// Clean stale entries periodically
let lastCleanup = 0;
function cleanupStore() {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
}

export function proxy(request: NextRequest) {
  cleanupStore();

  const { pathname } = request.nextUrl;

  // Rate limit auth endpoints
  if (pathname.startsWith("/api/auth/")) {
    const ip = getIp(request);
    const { limited, remaining, retryAfterMs } = isRateLimited(
      ip, "auth", AUTH_RATE_LIMIT, AUTH_WINDOW_MS
    );
    if (limited) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
            "X-RateLimit-Remaining": "0",
          },
        }
      );
    }
    const response = NextResponse.next();
    response.headers.set("X-RateLimit-Remaining", String(remaining));
    return response;
  }

  // Rate limit profile extraction (public, LLM-heavy)
  if (pathname === "/api/profile/extract" || pathname === "/api/profile/extract/") {
    const ip = getIp(request);
    const { limited, remaining, retryAfterMs } = isRateLimited(
      ip, "extract", EXTRACT_RATE_LIMIT, EXTRACT_WINDOW_MS
    );
    if (limited) {
      return NextResponse.json(
        { error: "Too many extraction requests. Please try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
        }
      );
    }
    const response = NextResponse.next();
    response.headers.set("X-RateLimit-Remaining", String(remaining));
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/auth/:path*", "/api/profile/extract"],
};
