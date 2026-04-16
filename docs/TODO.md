# TODO — Market Readiness

## Infrastructure

- [ ] **Custom domain** — Set up a custom domain (e.g. `civitas.ai`) on Vercel instead of `civitas-mu.vercel.app`
- [ ] **Remove `back_end/` directory** — Legacy Django code is no longer used; remove when confident everything works
- [x] **S3 bucket encryption** — SSE-S3 (AES256) already enabled on `civitas-ai` bucket
- [x] **S3 bucket versioning** — Enabled via `aws s3api put-bucket-versioning`
- [ ] **Error monitoring** — Set up Vercel analytics or Sentry for production error tracking
- [x] **Rate limiting** — In-memory sliding window rate limiter on login/signup (5 req/15min per IP)

## Security

- [x] **HTTPS-only cookies** — JWT moved from localStorage to HttpOnly/Secure/SameSite=Strict cookies
- [x] **Token revocation** — JWT expiry reduced to 24h; logout clears HttpOnly cookie server-side
- [x] **Input sanitization audit** — File upload magic byte validation, RFP ID format validation, LLM prompt injection mitigation (system/user message separation)
- [x] **Security headers** — CSP (removed `unsafe-eval`), HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, X-Permitted-Cross-Domain-Policies all configured in `next.config.ts`
- [x] **Dependency audit** — `npm audit fix` applied; Next.js upgraded to 16.2.4 (6 CVEs fixed); 0 remaining vulnerabilities
- [x] **Security event logging** — Structured JSON logging for login/signup/password events
- [x] **SSRF protection** — URL validation on PDF downloads in scraper pipeline (blocks private IPs, metadata endpoints)
- [x] **Docker non-root user** — Lambda container runs as non-root `scraper` user
- [x] **S3 default credentials** — Switched from hardcoded keys to default credential provider chain
- [ ] **IAM permissions** — CodeBuild/CloudWatch policies use `Resource: "*"` — scope to specific resources before production (kept for dev flexibility)
- [x] **Nonce-based CSP** — Per-request nonce generated in `proxy.ts`; `'unsafe-inline'` removed from script-src (style-src still needs it for Tailwind v4)
- [ ] **AWS Secrets Manager** — Move API keys from Lambda env vars to Secrets Manager

## LLM

- [x] **Upgrade from Groq free tier** — Groq's free tier has rate limits; upgrade or switch provider for production
- [ ] **LLM provider abstraction** — The extraction prompt is provider-agnostic, but the SDK calls are Groq-specific. Abstract to support OpenAI/Claude as alternatives
- [ ] **Extraction quality testing** — Compare pdf-parse (JS) vs pdfplumber (Python) output quality with real contract PDFs

## Data

- [ ] **Migrate old user data** — If old team provides working AWS credentials for `civitas-uploads`, migrate existing user profiles and contracts
- [x] **S3 concurrent write protection** — ETag-based optimistic locking on user data saves
- [ ] **Backup strategy** — Set up S3 cross-region replication or scheduled backups

## Scraping

- [ ] **Agentic scrapers (LA City, SF City)** — These two sites use the Claude-powered agentic scraper which requires different browser setup and the Anthropic API key. They currently fail on Lambda due to ENOSPC / browser issues. Need to: (1) test recipe caching on Lambda, (2) ensure Anthropic API key is available, (3) consider running these on GitHub Actions instead of Lambda if browser requirements are too heavy
- [ ] **PlanetBids / BidSync document login** — Most RFP documents on PlanetBids require vendor login to download (items marked with `*`). BidSync detail pages also appear to require authentication. Need to: (1) investigate creating vendor accounts for scraping, (2) determine if there's a public API alternative, (3) consider whether free addenda-only access is sufficient for matching, (4) evaluate legal/ToS implications of automated vendor account access
- [x] **Automated RFP scraping schedule** — EventBridge triggers Lambda every 48 hours with `{"mode": "all"}`
- [x] **PlanetBids status filtering** — Filter to "Bidding" status only (was scraping closed/awarded bids too)
- [x] **PlanetBids infinite scroll** — Scroll table container to load all rows (was capped at 30)
- [x] **Lambda batched chaining** — Sites run in batches of 3 per invocation, chained via async self-invocation

## Matching Algorithm

- [x] **User feedback loop** — Thumbs up/down on RFP cards with optional reason, stored in S3 with score/tier snapshots
- [ ] **Feedback-driven weight tuning** — Analyze collected feedback to adjust category weight distribution (25/15/15/10/10/10/5/5/5)
- [ ] **Tier threshold calibration** — Use feedback data to validate or adjust tier thresholds (75/55/35)
- [ ] **Synonym gap detection** — Mine bad-match feedback reasons to discover missing synonym groups
- [ ] **Feedback analytics dashboard** — Build an admin view to analyze feedback patterns across users

## Features

- [x] **Email uniqueness check** — S3-based email index (`system/email-index.json`) prevents duplicate registrations
- [x] **Password reset flow** — Forgot-password + reset-password with token-based verification
- [x] **Email verification** — Auto-verified in dev; token-based in production via SES
- [ ] **Profile completeness indicator** — Help users understand what profile data improves match quality
- [x] **Email delivery (SES)** — AWS SES integrated for verification + password reset emails; sandbox mode (set `CIVITAS_FROM_EMAIL` to verified sender); request production access when ready

## Testing

- [ ] **End-to-end tests** — Full user flow: signup → upload → profile → dashboard → proposal
- [ ] **API route unit tests** — Test each API route with edge cases
- [ ] **Profile aggregation tests** — Verify `refreshProfileFromContracts` produces identical results to the old Django version
- [ ] **Load testing** — Verify Vercel function limits work for concurrent users
