-- Convert profiles.prime_vs_sub and profiles.gov_experience from scalar text
-- columns to text[] so the onboarding wizard can capture multiple selections
-- (e.g. a contractor that bids as both prime and sub, or has both local +
-- state experience).
--
-- The legacy 'open_to_sub' single value expands to {prime,sub}.
-- Other legacy values map to their stripped equivalent ('prime_only' →
-- {prime}, 'sub_only' → {sub}, 'local' → {local}, etc.).
--
-- Idempotent: the DO block checks the current column type and only runs
-- the ALTER if it's still scalar text. This matters because this migration
-- was originally numbered 0004 and applied to prod before being renumbered
-- to 0005 to accommodate main's 0004_daily_roundup. Drizzle will retry it
-- on the next migrate; without the guard the ALTER's USING clause would
-- fail against an already-converted column.

DO $$
BEGIN
  IF (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'prime_vs_sub'
  ) = 'text' THEN
    ALTER TABLE "profiles"
      ALTER COLUMN "prime_vs_sub" TYPE text[]
      USING (
        CASE
          WHEN "prime_vs_sub" IS NULL OR "prime_vs_sub" = '' THEN NULL
          WHEN "prime_vs_sub" = 'prime_only' THEN ARRAY['prime']
          WHEN "prime_vs_sub" = 'sub_only' THEN ARRAY['sub']
          WHEN "prime_vs_sub" = 'open_to_sub' THEN ARRAY['prime', 'sub']
          ELSE ARRAY["prime_vs_sub"]
        END
      );
  END IF;

  IF (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'gov_experience'
  ) = 'text' THEN
    ALTER TABLE "profiles"
      ALTER COLUMN "gov_experience" TYPE text[]
      USING (
        CASE
          WHEN "gov_experience" IS NULL OR "gov_experience" = '' THEN NULL
          ELSE ARRAY["gov_experience"]
        END
      );
  END IF;
END $$;
