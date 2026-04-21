import { NextResponse, type NextRequest } from "next/server";
import { config as appConfig } from "./lib/config";

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

const AUTH_RATE_LIMIT = appConfig.rateLimit.auth.limit;
const AUTH_WINDOW_MS = appConfig.rateLimit.auth.windowMs;

const EXTRACT_RATE_LIMIT = appConfig.rateLimit.extract.limit;
const EXTRACT_WINDOW_MS = appConfig.rateLimit.extract.windowMs;

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

// CSP only allows a single leftmost wildcard, so build a concrete S3 origin from config.
const s3Origin = `https://${appConfig.aws.s3Bucket}.s3.${appConfig.aws.region}.amazonaws.com`;

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    // style-src still needs 'unsafe-inline' — Tailwind v4 injects <style> tags at runtime
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${s3Origin}`,
    "font-src 'self' data:",
    `connect-src 'self' ${s3Origin} https://api.groq.com`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function buildRequestHeaders(request: NextRequest, nonce: string, csp: string): Headers {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js auto-nonces its inline framework scripts by reading the CSP on the forwarded request.
  requestHeaders.set("Content-Security-Policy", csp);
  return requestHeaders;
}

function addCspResponseHeaders(response: NextResponse, nonce: string, csp: string): void {
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-nonce", nonce);
}

export function proxy(request: NextRequest) {
  cleanupStore();

  const { pathname } = request.nextUrl;

  // Generate nonce for every request
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);
  const requestHeaders = buildRequestHeaders(request, nonce, csp);

  // Rate limit auth mutation endpoints (login, signup, change-password)
  // Skip /api/auth/me/ — it's a session check called on every page load
  const isAuthMutation = pathname.startsWith("/api/auth/") &&
    !pathname.startsWith("/api/auth/me");
  if (isAuthMutation) {
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
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("X-RateLimit-Remaining", String(remaining));
    addCspResponseHeaders(response, nonce, csp);
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
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("X-RateLimit-Remaining", String(remaining));
    addCspResponseHeaders(response, nonce, csp);
    return response;
  }

  // All other routes — add CSP nonce
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  addCspResponseHeaders(response, nonce, csp);
  return response;
}

export const config = {
  // Match all routes except static assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png).*)"],
};
