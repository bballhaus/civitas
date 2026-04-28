// Migration runner. Invoke with: npm run db:migrate
//
// Reads .env.local automatically via Next.js's loader path; for plain `tsx`
// invocation we rely on the user having exported DATABASE_URL or copying
// .env.example to .env.local before running.

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "dotenv";
import { resolve } from "path";

// Load .env.local from front_end root.
config({ path: resolve(process.cwd(), ".env.local") });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL not set. Copy .env.example to .env.local first.");
  process.exit(1);
}

async function main() {
  const client = postgres(databaseUrl!, { max: 1 });
  const db = drizzle(client);

  // Ensure required extensions exist before running migrations. Drizzle's
  // migration system handles tables but doesn't manage extensions.
  await client`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await client`CREATE EXTENSION IF NOT EXISTS vector`;
  await client`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  console.log("Running migrations…");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations complete.");

  // Trigram indexes — Drizzle 0.36 doesn't generate gin_trgm_ops natively.
  // Idempotent CREATE INDEX IF NOT EXISTS statements; safe to run every time.
  console.log("Ensuring trigram indexes…");
  await client`
    CREATE INDEX IF NOT EXISTS idx_rfp_bidders_vendor_name_trgm
    ON rfp_bidders USING gin (vendor_name gin_trgm_ops)
  `;
  await client`
    CREATE INDEX IF NOT EXISTS idx_vendors_name_trgm
    ON vendors USING gin (name gin_trgm_ops)
  `;
  console.log("Trigram indexes ready.");

  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
