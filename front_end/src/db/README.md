# Civitas database (Postgres + Drizzle)

Source of truth for table shape: [docs/Architecture-v2.md § 4](../../../docs/Architecture-v2.md).

## Local setup

1. Install Docker Desktop (or any Postgres 16 with pgvector + pg_trgm extensions).
2. Start the local DB:

   ```bash
   # from repo root
   docker compose up -d postgres
   ```

3. Configure env (from `front_end/`):

   ```bash
   cp .env.example .env.local
   # edit .env.local — DATABASE_URL is already set for the docker-compose service
   ```

4. Run migrations:

   ```bash
   npm run db:migrate
   ```

   The migrate runner enables `pgcrypto`, `vector`, and `pg_trgm` extensions
   before running migrations, then adds trigram indexes that Drizzle's
   generator doesn't yet produce natively.

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run db:generate` | Compare schema.ts to existing migrations; produce a new migration file |
| `npm run db:migrate`  | Apply pending migrations + ensure trigram indexes |
| `npm run db:push`     | Push schema directly to DB (dev only — skips migration files) |
| `npm run db:studio`   | Open Drizzle Studio (visual table browser) |

## Workflow when changing the schema

1. Edit `schema.ts`.
2. `npm run db:generate` — produces a new `0001_<name>.sql` file in `migrations/`.
3. Review the generated SQL (check column types, index strategies).
4. `npm run db:migrate` — applies it locally.
5. Commit both the schema change AND the new migration file.

## Files

- `schema.ts` — Drizzle table definitions; type source for the rest of the codebase
- `client.ts` — singleton `db` instance; HMR-safe
- `migrate.ts` — migration runner used by `npm run db:migrate`
- `migrations/` — generated SQL files; do NOT hand-edit (re-generate instead)

## Production

`DATABASE_URL` is environment-specific. For Vercel deploys, set it in the Vercel
dashboard. Both AWS RDS and Vercel Postgres (Neon) work — same Postgres dialect,
both support pgvector. See § 3 of Architecture-v2.md for the rationale.
