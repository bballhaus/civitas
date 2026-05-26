// One-off: backfill profile.naics_codes for every existing profile by deriving
// codes from the user's specialties + capabilities.
//
// Why: the original "auto-derive" was a client-side hook in onboarding/Steps.tsx
// that only fired on fresh NaicsPicker selections. Profiles that onboarded
// before the hook shipped, used free-text adds, or edited via /profile-setup
// never got naics_codes populated, so NAICS-based matching reads them as
// having zero codes. The new server-side derive in lib/profile-naics.ts fixes
// the going-forward problem; this script fixes the historical state.
//
// Idempotent — recomputeProfileNaics unions with existing codes, so re-running
// is a no-op once everyone's caught up.
//
// Usage: npm run profile:backfill-naics

import "dotenv/config";
import { db } from "../src/db/client";
import { profiles } from "../src/db/schema";
import { recomputeProfileNaics } from "../src/lib/profile-naics";

async function main() {
  const rows = await db
    .select({ userId: profiles.userId, naicsCodes: profiles.naicsCodes })
    .from(profiles);
  console.log(`[backfill-naics] ${rows.length} profiles to process`);

  let changed = 0;
  for (const { userId, naicsCodes } of rows) {
    const before = new Set(naicsCodes ?? []);
    const after = await recomputeProfileNaics(userId);
    const added = after.filter((c) => !before.has(c));
    if (added.length > 0) {
      changed++;
      console.log(
        `[backfill-naics] ${userId}: +${added.length} codes (${added.slice(0, 5).join(", ")}${added.length > 5 ? "…" : ""})`,
      );
    }
  }
  console.log(`[backfill-naics] done; ${changed}/${rows.length} profiles updated`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-naics] failed:", err);
    process.exit(1);
  });
