-- Adds rfp_cache.scope_summary — a one-sentence LLM-generated description
-- of the actual work. Lives alongside (not replacing) the raw `description`
-- column so explainability stays intact: users can see both what the agency
-- wrote and what we inferred it meant.
--
-- Populated by the LLM tagger (see scripts/tag-rfp-naics.ts). Used by:
--   - buildRfpEmbeddingText, to give thin sources (PlanetBids/SF City/
--     BidSync, ~75% of catalog) something dense to embed instead of a
--     cryptic title alone
--   - the matcher's citation field, so explanations cite a coherent
--     scope sentence rather than raw scraped boilerplate
--   - eventually, an "About this RFP" snippet on the detail page

ALTER TABLE "rfp_cache" ADD COLUMN "scope_summary" text;
