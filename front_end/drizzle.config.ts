import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";
import { resolve } from "path";

// Load .env.local so `db:push` and `db:studio` find DATABASE_URL.
// `db:generate` doesn't need a database connection and works without it.
config({ path: resolve(__dirname, ".env.local") });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://placeholder@localhost/placeholder",
  },
  strict: true,
  verbose: true,
});
