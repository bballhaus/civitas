# Civitas Wiki

**Civitas** is a California government RFP matching platform that helps contractors discover, evaluate, and respond to government contract opportunities. The system uses AI-powered matching to score RFPs against company profiles, and generates tailored proposals and execution plans.

## Documentation

### Architecture
- **[Frontend Architecture](Frontend)** — Next.js app structure, pages, API routes, state management, and UI flows
- **[Backend Architecture](Backend)** — Next.js API routes, S3 storage model, JWT authentication, LLM extraction, and API endpoints

### Product
- **[Key Features](Key-Features)** — End-to-end explanation of each major feature: RFP discovery, profile building, matching, proposal generation, status tracking, and web scraping pipeline
- **[Matching Algorithm](Matching-Algorithm)** — Deep dive into the 3-stage scoring pipeline, 10 scoring categories, synonym expansion, canonicalization, and explanation generation

### Security
- **[Security & Optimization](Security)** — Full security audit results, all implemented controls (nonce CSP, HttpOnly cookies, rate limiting, SSRF protection, LLM safety, SES email), and remaining work

### Operations
- **[TODO](TODO)** — Remaining work for market readiness

### Testing
- **[Example Test Profiles](Example-Test-Profiles)** — Ready-made company profiles with test PDFs for verifying extraction and matching

## Quick Links

| Component | Dev URL | Prod URL |
|---|---|---|
| App | `localhost:3000` | `civitas-mu.vercel.app` |
| S3 Bucket | — | `civitas-ai` (us-east-1) |

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Backend | Next.js API Routes (same deployment) |
| Auth | JWT (HS256, HttpOnly cookies, 24h expiry) via jose + bcryptjs |
| Storage | AWS S3 (JSON files, SSE-S3 encrypted, versioned) |
| Email | AWS SES (sandbox) |
| AI/LLM | Groq (llama-3.1-8b-instant) for extraction & generation |
| Scraping | Playwright, Python, pdfplumber |
| Deployment | Vercel (frontend), AWS Lambda (scraping) |
