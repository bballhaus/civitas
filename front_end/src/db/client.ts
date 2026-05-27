// Postgres connection singleton.
//
// Uses postgres.js (recommended by Drizzle for Postgres). Connection pooling
// is handled by the driver, but `max` matters in serverless: each warm
// Vercel function instance keeps its own pool, so total connections =
// (max per pool) × (concurrent instances). RDS db.t4g.micro caps at ~110
// connections (with reserved superuser slots eating into that), so we
// keep `max` small (3) to leave headroom for ~30+ concurrent instances
// during scrape bursts. Symptom of getting this wrong is PG error 53300
// "remaining connection slots are reserved for SUPERUSER" cascading into
// every downstream query — observed during 2026-05-26 scrape bursts that
// blew past the limit with the previous max=10.
//
// Long-term fix is RDS Proxy or pgbouncer in front of the instance. This
// keeps us under the limit until that lands.
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
  // RDS Postgres rejects unencrypted connections. Force SSL whenever the
  // URL points at AWS RDS so callers don't have to remember to append
  // ?sslmode=require to the env var. No-op for local docker postgres or
  // anything else that doesn't enforce TLS.
  const isRds = databaseUrl.includes(".rds.amazonaws.com");
  const client =
    globalThis.__civitas_pg ??
    postgres(databaseUrl, {
      // Keep low: per-instance × #instances must stay under RDS max_connections.
      // See header comment for the math.
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      ...(isRds ? { ssl: "require" as const } : {}),
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
