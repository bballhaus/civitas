import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy: nonce-based CSP + rate limiting.
 *
 * Runs at the edge before all route handlers.
 * - Generates a per-request nonce for Content-Security-Policy (prevents XSS)
 * - Rate limits auth and extraction endpoints (prevents brute-force/abuse)
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

// ── CSP nonce generation ──

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // style-src still needs 'unsafe-inline' — Tailwind v4 injects <style> tags at runtime
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.s3.*.amazonaws.com",
    "font-src 'self' data:",
    "connect-src 'self' https://*.s3.*.amazonaws.com https://api.groq.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function addCspHeaders(response: NextResponse, nonce: string): void {
  response.headers.set("Content-Security-Policy", buildCsp(nonce));
  response.headers.set("x-nonce", nonce);
}

export function proxy(request: NextRequest) {
  cleanupStore();

  const { pathname } = request.nextUrl;

  // Generate nonce for every request
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

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
    addCspHeaders(response, nonce);
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
    addCspHeaders(response, nonce);
    return response;
  }

  // All other routes — add CSP nonce
  const response = NextResponse.next();
  addCspHeaders(response, nonce);
  return response;
}

export const config = {
  // Match all routes except static assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png).*)"],
};
