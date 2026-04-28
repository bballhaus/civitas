// Postgres connection singleton.
//
// Uses postgres.js (recommended by Drizzle for Postgres). Connection pooling
// is handled by the driver — no extra pool config needed in serverless.
//
// In Next.js dev mode, the module gets re-evaluated on hot reload, which
// would create a new pool every time. Stash the connection on globalThis
// so HMR doesn't leak handles.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. See front_end/.env.example for the local-dev value.",
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __civitas_pg: ReturnType<typeof postgres> | undefined;
}

const client =
  globalThis.__civitas_pg ??
  postgres(databaseUrl, {
    max: 10, // pool size; serverless cold starts get one, warm gets reused
    idle_timeout: 20, // seconds
    connect_timeout: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__civitas_pg = client;
}

export const db = drizzle(client, { schema });
export { schema };
