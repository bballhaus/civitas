# Civitas — Frontend (Next.js)

The Next.js application that powers the Civitas web UI and API. The same deployment serves the public pages, the authenticated app (matches, tracker, profile, contracts, onboarding), and every server-side API route. See [docs/Frontend.md](../docs/Frontend.md) and [docs/Backend.md](../docs/Backend.md) for the full architecture, and [src/db/README.md](src/db/README.md) for the Postgres + Drizzle layer.

## Quick start

```bash
# from the repo root
docker compose up -d postgres        # local Postgres with pgvector + pg_trgm
cd front_end
cp .env.example .env.local           # then fill in the required env vars
npm install
npm run db:migrate                   # applies migrations + creates trigram indexes
npm run dev                          # http://localhost:3000
```

## Required env vars (`.env.local`)

```
JWT_SECRET=...                  # >= 32 chars
DATABASE_URL=postgres://...     # docker-compose default works locally
AWS_ACCESS_KEY_ID=...           # S3 + DynamoDB
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=civitas-ai
GROQ_API_KEY=...                # set whichever LLM keys match civitas.config.json
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
RESEND_API_KEY=...              # transactional email; optional in dev (logs to console)
CIVITAS_FROM_EMAIL="Civitas <register@civitas-ai.net>"
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Next.js dev server on `localhost:3000` |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run db:generate` | Generate a new Drizzle migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations + ensure trigram indexes |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run rfp-cache:populate` | Refresh `rfp_cache` from scraped manifests |
| `npm run rfp-cache:embed` | Embed RFPs for semantic matching |
| `npm run kpi:funnel [username]` | Run the KPI funnel CLI report — see [docs/KPIs.md](../docs/KPIs.md) |

## Deployment

Pushed to `main` deploys to Vercel (`civitas-ai.net`). All API routes run as serverless functions; the Postgres connection points at the AWS RDS instance via the `DATABASE_URL` env var set in the Vercel dashboard.
