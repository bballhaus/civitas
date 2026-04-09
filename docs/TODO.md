# TODO — Market Readiness

## Infrastructure

- [ ] **Custom domain** — Set up a custom domain (e.g. `civitas.ai`) on Vercel instead of `civitas-mu.vercel.app`
- [ ] **Remove `back_end/` directory** — Legacy Django code is no longer used; remove when confident everything works
- [ ] **S3 bucket encryption** — Enable server-side encryption (SSE-S3) on `civitas-ai` bucket for data at rest
- [ ] **S3 bucket versioning** — Enable versioning for accidental deletion protection
- [ ] **Error monitoring** — Set up Vercel analytics or Sentry for production error tracking
- [ ] **Rate limiting** — Add rate limiting to auth endpoints to prevent brute force attacks

## Security

- [ ] **HTTPS-only cookies** — Consider moving JWT from localStorage to httpOnly cookies for XSS protection
- [ ] **Token revocation** — Currently JWT logout is client-side only; implement server-side token blacklist if needed
- [ ] **Input sanitization audit** — Review all API routes for injection vulnerabilities
- [ ] **Security headers** — Add CSP, HSTS, X-Frame-Options headers via `next.config.ts`
- [ ] **Dependency audit** — Run `npm audit` and address vulnerabilities

## LLM

- [ ] **Upgrade from Groq free tier** — Groq's free tier has rate limits; upgrade or switch provider for production
- [ ] **LLM provider abstraction** — The extraction prompt is provider-agnostic, but the SDK calls are Groq-specific. Abstract to support OpenAI/Claude as alternatives
- [ ] **Extraction quality testing** — Compare pdf-parse (JS) vs pdfplumber (Python) output quality with real contract PDFs

## Data

- [ ] **Migrate old user data** — If old team provides working AWS credentials for `civitas-uploads`, migrate existing user profiles and contracts
- [ ] **S3 concurrent write protection** — User JSON is a single file; concurrent requests could overwrite each other. Add S3 ETag optimistic locking if this becomes an issue
- [ ] **Backup strategy** — Set up S3 cross-region replication or scheduled backups

## Features

- [ ] **Email uniqueness check** — Signup currently only checks username uniqueness, not email (across all users would require an email index in S3)
- [ ] **Password reset flow** — No forgot-password functionality exists yet
- [ ] **Email verification** — No email verification on signup
- [ ] **Profile completeness indicator** — Help users understand what profile data improves match quality
- [ ] **Automated RFP scraping schedule** — The scraper currently runs manually; set up a cron job or scheduled task

## Testing

- [ ] **End-to-end tests** — Full user flow: signup → upload → profile → dashboard → proposal
- [ ] **API route unit tests** — Test each API route with edge cases
- [ ] **Profile aggregation tests** — Verify `refreshProfileFromContracts` produces identical results to the old Django version
- [ ] **Load testing** — Verify Vercel function limits work for concurrent users
