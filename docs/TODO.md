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
- [ ] **Dependency audit** — Run `npm audit` and address vulnerabilities
- [x] **Security event logging** — Structured JSON logging for login/signup/password events
- [x] **SSRF protection** — URL validation on PDF downloads in scraper pipeline (blocks private IPs, metadata endpoints)
- [x] **Docker non-root user** — Lambda container runs as non-root `scraper` user
- [x] **S3 default credentials** — Switched from hardcoded keys to default credential provider chain
- [ ] **IAM permissions** — CodeBuild/CloudWatch policies use `Resource: "*"` — scope to specific resources before production (kept for dev flexibility)
- [ ] **Nonce-based CSP** — Remove `'unsafe-inline'` from script-src via nonce-based CSP (larger change, deferred)
- [ ] **AWS Secrets Manager** — Move API keys from Lambda env vars to Secrets Manager

## LLM

- [ ] **Upgrade from Groq free tier** — Groq's free tier has rate limits; upgrade or switch provider for production
- [ ] **LLM provider abstraction** — The extraction prompt is provider-agnostic, but the SDK calls are Groq-specific. Abstract to support OpenAI/Claude as alternatives
- [ ] **Extraction quality testing** — Compare pdf-parse (JS) vs pdfplumber (Python) output quality with real contract PDFs

## Data

- [ ] **Migrate old user data** — If old team provides working AWS credentials for `civitas-uploads`, migrate existing user profiles and contracts
- [x] **S3 concurrent write protection** — ETag-based optimistic locking on user data saves
- [ ] **Backup strategy** — Set up S3 cross-region replication or scheduled backups

## Scraping

- [ ] **Agentic scrapers (LA City, SF City)** — These two sites use the Claude-powered agentic scraper which requires different browser setup and the Anthropic API key. They currently fail on Lambda due to ENOSPC / browser issues. Need to: (1) test recipe caching on Lambda, (2) ensure Anthropic API key is available, (3) consider running these on GitHub Actions instead of Lambda if browser requirements are too heavy
- [x] **Automated RFP scraping schedule** — EventBridge triggers Lambda every 4 hours with `{"mode": "all"}`
- [x] **PlanetBids status filtering** — Filter to "Bidding" status only (was scraping closed/awarded bids too)
- [x] **PlanetBids infinite scroll** — Scroll table container to load all rows (was capped at 30)
- [x] **Lambda batched chaining** — Sites run in batches of 3 per invocation, chained via async self-invocation

## Features

- [x] **Email uniqueness check** — S3-based email index (`system/email-index.json`) prevents duplicate registrations
- [x] **Password reset flow** — Forgot-password + reset-password with token-based verification
- [x] **Email verification** — Auto-verified in `NODE_ENV=development`; token-based verification in production (verification URL logged to console until SES integration)
- [ ] **Profile completeness indicator** — Help users understand what profile data improves match quality
- [ ] **Email delivery (SES)** — Integrate AWS SES for email verification and password reset emails in production

## Testing

- [ ] **End-to-end tests** — Full user flow: signup → upload → profile → dashboard → proposal
- [ ] **API route unit tests** — Test each API route with edge cases
- [ ] **Profile aggregation tests** — Verify `refreshProfileFromContracts` produces identical results to the old Django version
- [ ] **Load testing** — Verify Vercel function limits work for concurrent users
