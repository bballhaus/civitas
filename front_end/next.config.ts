import type { NextConfig } from "next";

// CSP is set dynamically in proxy.ts (nonce-based).
// Only non-CSP security headers are set here.
const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  // Old v1 surface → v2 redirects. The v1 pages (/dashboard, /profile,
  // /profile-setup) still exist in app/ as fallbacks while we validate
  // v2 — these redirects intercept any bookmarked v1 URLs at the edge,
  // so users land on the live v2 surface. `permanent: false` keeps this
  // reversible if we ever decide to re-promote v1.
  //
  // `/dashboard/rfp/:id` is intentionally NOT redirected — the v2
  // detail page at /matches/:id is still maturing, so the legacy
  // detail page stays reachable as a fallback. Only the bare
  // /dashboard list view bounces.
  async redirects() {
    return [
      { source: "/dashboard", destination: "/matches", permanent: false },
      { source: "/profile", destination: "/profile/v2", permanent: false },
      { source: "/profile-setup", destination: "/onboarding", permanent: false },
    ];
  },
  serverExternalPackages: ["mupdf"],
};

export default nextConfig;
