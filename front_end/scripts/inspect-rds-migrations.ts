// Inspect __drizzle_migrations + the new columns so we can plan the cleanup.
// Read-only; safe to run against prod.

import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const rows = await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  console.log("drizzle.__drizzle_migrations rows:");
  for (const r of rows) {
    console.log(`  id=${r.id} created_at=${r.created_at} hash=${r.hash.slice(0, 16)}...`);
  }
  const col = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='work_areas' AND column_name='radius_miles'`;
  console.log("work_areas.radius_miles exists:", col.length > 0);

  const pu = await sql`SELECT to_regclass('public.pending_users') AS exists`;
  console.log("pending_users table exists:", pu[0].exists !== null);

  const ld = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profiles' AND column_name='last_dashboard_viewed_at'`;
  console.log("profiles.last_dashboard_viewed_at exists:", ld.length > 0);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
