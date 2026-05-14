// One-off: realign the RDS migration journal so the old 0001_add_radius_miles
// row points at the new 0003_add_radius_miles entry instead. SQL content +
// hash are identical, only the `when` timestamp changed when we renumbered.
//
// What this does (in a transaction):
//   1. Find the row in drizzle.__drizzle_migrations whose hash matches the
//      new 0003 file (sha256 = bea51df...).
//   2. If exactly one matches, update its created_at to the journal's new
//      `when` value so the next migrate call sees it as already applied.
//   3. Refuse to touch anything if more or fewer than one row matches.
//
// Safe — no schema changes, no data deletion, no DROP. Idempotent.

import postgres from "postgres";

const TARGET_HASH = "bea51df43e8efe497d31685270145f02b1a3796f9a6234434ff9ae77c5591d9d";
const NEW_WHEN = 1778749379324;

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      const matches = await tx`
        SELECT id, created_at, hash
          FROM drizzle.__drizzle_migrations
         WHERE hash = ${TARGET_HASH}
      `;
      if (matches.length === 0) {
        console.log(
          `No row with hash ${TARGET_HASH.slice(0, 16)}… nothing to realign — drizzle will apply 0003 on next migrate.`,
        );
        return;
      }
      if (matches.length > 1) {
        throw new Error(
          `Expected 0 or 1 row with hash ${TARGET_HASH.slice(0, 16)}…, found ${matches.length}. Aborting.`,
        );
      }
      const row = matches[0];
      if (Number(row.created_at) === NEW_WHEN) {
        console.log(`Row id=${row.id} already aligned (created_at=${NEW_WHEN}).`);
        return;
      }
      await tx`
        UPDATE drizzle.__drizzle_migrations
           SET created_at = ${NEW_WHEN}
         WHERE id = ${row.id}
      `;
      console.log(
        `Realigned row id=${row.id}: created_at ${row.created_at} → ${NEW_WHEN}`,
      );
    });
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
