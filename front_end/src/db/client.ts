// Postgres connection singleton.
//
// Uses postgres.js (recommended by Drizzle for Postgres). Connection pooling
// is handled by the driver — no extra pool config needed in serverless.
//
// The `db` export is lazy: it doesn't connect (or even check DATABASE_URL)
// until a query runs. This matters for Next.js build-time page data
// collection — Next imports every route module to enumerate its handlers,
// and at that point the deploy env doesn't have DATABASE_URL set yet.
// A throw at module load would fail the build; deferring to first use
// only fails the request, not the deploy.
//
// In Next.js dev, modules get re-evaluated on hot reload; stash the
// connection on globalThis so HMR doesn't leak handles.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __civitas_pg: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __civitas_db: ReturnType<typeof createDb> | undefined;
}

function createDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. See front_end/.env.example for the local-dev value.",
    );
  }
  const client =
    globalThis.__civitas_pg ??
    postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  if (process.env.NODE_ENV !== "production") {
    globalThis.__civitas_pg = client;
  }
  return drizzle(client, { schema });
}

// Lazy proxy: instantiates the real db on first property access.
// `value.bind(target)` is needed because Drizzle's query-builder methods
// rely on `this` to access the session and dialect.
export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_target, prop, receiver) {
    if (!globalThis.__civitas_db) {
      globalThis.__civitas_db = createDb();
    }
    const value = Reflect.get(globalThis.__civitas_db, prop, receiver);
    return typeof value === "function"
      ? value.bind(globalThis.__civitas_db)
      : value;
  },
});

export { schema };
