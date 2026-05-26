# Security & Optimization

This document covers all security controls implemented in Civitas, the audit that prompted them, and remaining work.

## Audit Summary (April 2026)

A full security audit was performed across the frontend (Next.js), backend (API routes), scraping pipeline (Python/Lambda), and infrastructure (AWS). The audit identified 17 issues across critical, high, and medium severity. All actionable issues have been resolved.

## Authentication

### JWT in HttpOnly Cookies

**Before:** JWT tokens were stored in `localStorage`, accessible to any JavaScript running on the page. Combined with a permissive CSP, this created an XSS-to-account-takeover chain.

**After:** JWTs are stored in `HttpOnly`, `Secure`, `SameSite=Strict` cookies set by the server. Client-side JavaScript cannot read or exfiltrate the token.

| Setting | Value |
|---------|-------|
| HttpOnly | `true` |
| Secure | `true` in production, `false` in dev |
| SameSite | `Strict` |
| Max-Age | 7 days (driven by `auth.jwtExpiryDays` in `civitas.config.json`) |
| Path | `/` |

**Files:** `front_end/src/lib/auth.ts` (cookie helpers), `front_end/src/app/api/auth/login/route.ts`, `signup/route.ts`, `logout/route.ts`

### Token Lifetime

JWT expiry is 7 days, sourced from `auth.jwtExpiryDays` in `civitas.config.json`. Logout clears the cookie server-side (sets `Max-Age=0`), making the token immediately unusable.

### Password Security

- **Hashing:** bcrypt with 12 rounds (`front_end/src/lib/auth.ts`)
- **Validation:** Minimum 8 chars, at least one uppercase, one lowercase, one special character
- **Legacy migration:** Django PBKDF2 hashes are transparently re-hashed to bcrypt on first login
- **JWT secret:** Validated to be at least 32 characters; rejects placeholder values

### Password Reset

Full forgot-password flow with token-based reset:
1. User submits email to `/api/auth/forgot-password/`
2. Server generates a `crypto.randomUUID()` token with 1-hour expiry
3. Email sent via Resend (or logged to console in dev when `RESEND_API_KEY` is unset)
4. User clicks link to `/reset-password?token=...&username=...`
5. Server validates token, hashes new password, clears token

**Files:** `front_end/src/app/api/auth/forgot-password/route.ts`, `reset-password/route.ts`, `front_end/src/app/forgot-password/page.tsx`, `reset-password/page.tsx`

### Email Verification

- **Production:** Token-based verification email sent via Resend on signup
- **Development:** Auto-verified when `NODE_ENV=development` and `RESEND_API_KEY` / `CIVITAS_FROM_EMAIL` are unset
- **Storage:** `email_verified` and `email_verification_token` fields on the `users` table

**File:** `front_end/src/app/api/auth/verify-email/route.ts`

### Email Uniqueness

S3-based email index at `system/email-index.json` maps emails to usernames. Checked on signup to prevent duplicate registrations.

**File:** `front_end/src/lib/email-index.ts`

## Rate Limiting

### Proxy-Level (Edge)

The Next.js proxy (`front_end/src/proxy.ts`) applies rate limiting at the edge before requests reach API handlers. Limits are sourced from `civitas.config.json`:

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/auth/*` | 10 requests | 1 minute |
| `/api/profile/extract` | 5 requests | 1 minute |

### Route-Level

Individual auth routes apply stricter per-IP limits using the sliding window rate limiter (`front_end/src/lib/rate-limit.ts`):

| Endpoint | Limit | Window |
|----------|-------|--------|
| Login | 5 attempts | 15 minutes |
| Signup | 5 attempts | 15 minutes |
| Forgot Password | 3 attempts | 15 minutes |

Returns `429 Too Many Requests` with `Retry-After` header.

## Content Security Policy

### Nonce-Based CSP

**Before:** CSP included `'unsafe-inline'` and `'unsafe-eval'` for scripts, effectively disabling XSS protection.

**After:** Per-request cryptographic nonces are generated in `proxy.ts` and injected into the CSP header. No `unsafe-inline` or `unsafe-eval` for scripts.

```
script-src 'self' 'nonce-{random}'
style-src 'self' 'unsafe-inline'
```

`style-src` still requires `'unsafe-inline'` because Tailwind CSS v4 injects `<style>` tags at runtime that don't support nonces.

**Files:** `front_end/src/proxy.ts`, `front_end/src/app/layout.tsx` (passes nonce to server components)

### Other Security Headers

Set via `front_end/next.config.ts`:

| Header | Value |
|--------|-------|
| Strict-Transport-Security | `max-age=63072000; includeSubDomains; preload` |
| X-Frame-Options | `DENY` |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | `camera=(), microphone=(), geolocation=()` |
| X-Permitted-Cross-Domain-Policies | `none` |

## Input Validation

### File Uploads

Contract uploads (`/api/contracts/`) are validated with:
1. **Extension check:** Only `.pdf`, `.docx`, `.doc`, `.txt` allowed
2. **Magic byte check:** File content is verified against expected signatures (e.g., `%PDF` for PDFs, `PK` for DOCX/ZIP, OLE header for DOC)
3. **Size limit:** 25 MB maximum

**File:** `front_end/src/app/api/contracts/route.ts`

### RFP ID Validation

All RFP ID fields are validated with `^[\w\-.:]{1,200}$` — alphanumeric, dashes, dots, colons, underscores, max 200 characters.

**File:** `front_end/src/app/api/user/rfp-status/route.ts`

## LLM Security

### Prompt Injection Mitigation

**Before:** User-uploaded document text was interpolated directly into the LLM prompt via string replacement (`prompt.replace("{text}", text)`). A malicious document could inject instructions.

**After:** System/user message separation. The extraction instructions are sent as a `system` message, and document text is sent as a `user` message. The system prompt explicitly instructs the LLM to ignore any directives in the document text.

**Files:** `front_end/src/lib/extraction.ts`, `webscraping/v2/pipeline/enrich.py`

## Infrastructure Security

### S3 Bucket (`civitas-ai`)

| Setting | Status |
|---------|--------|
| Server-side encryption | SSE-S3 (AES256) enabled |
| Versioning | Enabled |
| Public access | All 4 block settings enabled |
| Credential handling | Default provider chain (no hardcoded keys) |
| Concurrent write protection | ETag-based optimistic locking on user data |

### SSRF Protection

The PDF download function in the scraping pipeline (`webscraping/v2/pipeline/enrich.py`) validates URLs before fetching:
- Only `http` and `https` schemes allowed
- DNS-resolved IPs checked against private, loopback, link-local, and reserved ranges
- AWS metadata endpoint (`169.254.169.254`) and GCP metadata (`metadata.google.internal`) explicitly blocked

### Docker Container

The Lambda container image (`webscraping/v2/deploy/Dockerfile`) runs as a non-root user (`scraper`, UID 1000). If the Chromium browser or Python code is exploited, the attacker does not have root access.

### Credential Management

All S3 clients use the AWS SDK default credential provider chain instead of explicit `accessKeyId`/`secretAccessKey`. This works with:
- Environment variables on Vercel
- IAM roles on Lambda
- Instance metadata on EC2

**Files:** `front_end/src/lib/s3.ts`, `front_end/src/app/api/events/route.ts`

## Email (Resend)

Transactional emails for verification, password reset, and the daily roundup digest are sent via Resend.

**File:** `front_end/src/lib/email.ts`

### Setup

1. Add the sending domain (e.g. `civitas-ai.net`) to the Resend dashboard and verify DNS.
2. Set `RESEND_API_KEY` (starts with `re_`) in environment variables.
3. Set `CIVITAS_FROM_EMAIL`, e.g. `Civitas <register@civitas-ai.net>`.

### Bounce / Complaint Handling

The legacy AWS SES bounce webhook (`/api/email/...` with SNS signature verification in `lib/sns-verify.ts`) is retained for backward compatibility with previously-sent SES messages; new outbound mail flows entirely through Resend.

### Graceful Fallback

If `RESEND_API_KEY` or `CIVITAS_FROM_EMAIL` is unset, `lib/email.ts` logs the message to the console and returns success so signup/reset/daily-roundup flows continue to work locally.

## Security Event Logging

Structured JSON logs are emitted for all auth events. These are captured by Vercel logs and CloudWatch.

**Events logged:** `login_success`, `login_failure`, `signup`, `password_change`, `password_reset_request`, `password_reset_complete`, `email_verified`

**Format:**
```json
{
  "level": "security",
  "timestamp": "2026-04-16T...",
  "type": "login_failure",
  "username": "jdoe",
  "ip": "1.2.3.4"
}
```

**File:** `front_end/src/lib/security-log.ts`

## Remaining Work

| Item | Priority | Notes |
|------|----------|-------|
| IAM permission scoping | High | CodeBuild/CloudWatch use `Resource: "*"` -- kept for dev, scope before production |
| AWS Secrets Manager | Medium | Move Lambda LLM keys (Anthropic, Groq) from env vars to Secrets Manager |
| Style nonce support | Low | Tailwind v4 needs `'unsafe-inline'` for style-src; nonce support pending upstream |
| CSRF tokens | Low | `SameSite=Strict` cookies mitigate CSRF for same-origin; explicit tokens deferred |
