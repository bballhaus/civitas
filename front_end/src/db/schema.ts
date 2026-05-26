// Drizzle schema for Civitas v2.
// Source of truth for table shape: docs/Architecture-v2.md § 4.
// Source of truth for which fields each scraping source populates:
// webscraping/v2/COVERAGE.md.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Holds signup attempts that have not yet clicked the verification link.
// On verify, the row is promoted into `users` (in a transaction) and deleted.
// On expiry, a cleanup job (or the next signup with the same email) removes it.
export const pendingUsers = pgTable(
  "pending_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull().unique(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    verificationToken: text("verification_token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_pending_users_token").on(t.verificationToken)],
);

// ---------------------------------------------------------------------------
// Profile (1:1 with users) — the asserted truth about a contractor
// ---------------------------------------------------------------------------

export const profiles = pgTable(
  "profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    companyName: text("company_name"),
    yearFounded: integer("year_founded"),
    employeeBand: text("employee_band"), // '1' | '2-10' | '11-50' | ...
    website: text("website"),
    // preferences
    scopeMinUsd: bigint("scope_min_usd", { mode: "number" }),
    scopeMaxUsd: bigint("scope_max_usd", { mode: "number" }),
    durationPref: text("duration_pref"), // 'short' | 'any' | 'retention_ok'
    complexityPref: text("complexity_pref"), // 'simple_only' | 'any' | 'any_with_subs'
    // Multi-select: a single contractor can bid as prime on some RFPs and
    // sub on others, so the v2 schema stores both possibilities as an array.
    // Values: 'prime' | 'sub'.
    primeVsSub: text("prime_vs_sub").array(),
    // Multi-select: a contractor may have experience across several tiers
    // (e.g. local + state) without implying the whole hierarchy. Values:
    // 'none' | 'local' | 'state' | 'federal'. Empty array == not answered.
    govExperience: text("gov_experience").array(),
    // 6-digit NAICS codes the contractor works under. Union of explicitly
    // picked codes (dedicated NAICS step) and codes derived server-side
    // from any NAICS-titled specialty/capability the user holds — see
    // lib/profile-naics.ts. Source of truth for NAICS-based matching.
    naicsCodes: text("naics_codes").array(),
    // vendor identity (links to webscraping vendor index)
    vendorFingerprint: text("vendor_fingerprint"),
    vendorResolvedAt: timestamp("vendor_resolved_at", { withTimezone: true }),
    // meta
    completenessScore: real("completeness_score").default(0),
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    embeddingUpdatedAt: timestamp("embedding_updated_at", { withTimezone: true }),
    lastDashboardViewedAt: timestamp("last_dashboard_viewed_at", { withTimezone: true }),
    // Daily roundup email: opt-in toggle, IANA timezone captured from the
    // browser on opt-in, and last-sent timestamp used by the cron to dedupe.
    // Hour-of-day is fixed at 7am local in the cron handler.
    dailyRoundupEnabled: boolean("daily_roundup_enabled").notNull().default(false),
    dailyRoundupTimezone: text("daily_roundup_timezone"),
    dailyRoundupLastSentAt: timestamp("daily_roundup_last_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_profiles_vendor_fingerprint").on(t.vendorFingerprint)],
);

// ---------------------------------------------------------------------------
// Specialties — the bread-and-butter (primary match dimension)
// ---------------------------------------------------------------------------

export const specialties = pgTable(
  "specialties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    canonicalId: text("canonical_id"),
    weight: text("weight").notNull().default("primary"), // 'primary' | 'secondary'
    embedding: vector("embedding", { dimensions: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_specialties_user").on(t.userId),
    index("idx_specialties_embedding").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    unique("uq_specialties_user_value").on(t.userId, t.value),
  ],
);

// ---------------------------------------------------------------------------
// Capabilities — broader than specialties (what they CAN do)
// ---------------------------------------------------------------------------

export const capabilities = pgTable(
  "capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    canonicalId: text("canonical_id"),
    embedding: vector("embedding", { dimensions: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_capabilities_user").on(t.userId),
    index("idx_capabilities_embedding").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    unique("uq_capabilities_user_value").on(t.userId, t.value),
  ],
);

// ---------------------------------------------------------------------------
// Licenses — typed by class to enable binary matching
// ---------------------------------------------------------------------------

export const licenses = pgTable(
  "licenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    licenseClass: text("license_class").notNull(), // 'A', 'B', 'C-12', 'PE', 'DIR', ...
    licenseNumber: text("license_number"),
    expiresOn: date("expires_on"),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_licenses_user").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Certifications — hard vs soft is a column, not separate tables
// ---------------------------------------------------------------------------

export const certifications = pgTable(
  "certifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    canonicalId: text("canonical_id").notNull(), // 'dvbe' | 'fedramp' | 'iso_9001' | ...
    displayName: text("display_name").notNull(),
    kind: text("kind").notNull(), // 'hard' | 'soft'
    expiresOn: date("expires_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_certifications_user_kind").on(t.userId, t.kind),
    unique("uq_certifications_user_canonical").on(t.userId, t.canonicalId),
  ],
);

// ---------------------------------------------------------------------------
// Work areas — with hard flag
// ---------------------------------------------------------------------------

export const workAreas = pgTable(
  "work_areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'city' | 'county' | 'metro' | 'state'
    name: text("name").notNull(),
    isHard: boolean("is_hard").notNull().default(false), // "won't travel outside this"
    // Radius in miles. Only meaningful when isHard=true — encodes "won't
    // travel more than N miles outside <name>". null = no radius asserted
    // (the gate becomes a simple substring check on rfp.location).
    radiusMiles: integer("radius_miles"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_work_areas_user").on(t.userId),
    unique("uq_work_areas_user_kind_name").on(t.userId, t.kind, t.name),
  ],
);

// ---------------------------------------------------------------------------
// Agency relationships — auto-populated from vendor fingerprint, manually editable
// ---------------------------------------------------------------------------

export const agencyRelationships = pgTable(
  "agency_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agencyCanonical: text("agency_canonical").notNull(), // 'caltrans', 'dgs', ...
    agencyDisplay: text("agency_display").notNull(),
    role: text("role").notNull(), // 'prime' | 'sub'
    contractCount: integer("contract_count").notNull().default(1),
    lastContractAt: date("last_contract_at"),
    strength: smallint("strength").notNull().default(1), // 1-5
    source: text("source").notNull().default("user"), // 'user' | 'vendor_fingerprint' | 'extraction'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_agency_relationships_user").on(t.userId),
    unique("uq_agency_relationships_user_agency_role").on(
      t.userId,
      t.agencyCanonical,
      t.role,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Contracts — uploaded documents (evidence, not authority)
// ---------------------------------------------------------------------------

export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentType: text("document_type").notNull(),
    // proposal | executed_contract | capability_statement | license_doc |
    // rfp_solicitation | other
    contractStatus: text("contract_status"),
    // won | lost | in_progress | unknown — only relevant for proposal/executed_contract
    s3Key: text("s3_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    title: text("title"),
    // extracted basics
    issuingAgency: text("issuing_agency"),
    contractValueUsd: bigint("contract_value_usd", { mode: "number" }),
    durationText: text("duration_text"),
    role: text("role"), // 'prime' | 'sub'
    awardDate: date("award_date"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    // diagnostic
    rawExtraction: jsonb("raw_extraction"),
    extractedByModel: text("extracted_by_model"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    extractedText: text("extracted_text"),
    textTruncated: boolean("text_truncated").notNull().default(false),
    piiRedactedCount: integer("pii_redacted_count").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_contracts_user").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Claims — every fact extracted, with provenance and review status
// ---------------------------------------------------------------------------

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").references(() => contracts.id, {
      onDelete: "cascade",
    }),
    fieldPath: text("field_path").notNull(),
    // 'specialties.value' | 'licenses.class' | 'agency_relationships.agency' | ...
    value: text("value").notNull(),
    snippet: text("snippet"), // text from doc that justifies this claim
    confidence: real("confidence"), // post-multiplier (LLM × source-type weight)
    status: text("status").notNull().default("pending"),
    // 'pending' | 'accepted' | 'rejected'
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_claims_user_status").on(t.userId, t.status),
    index("idx_claims_contract").on(t.contractId),
  ],
);

// ---------------------------------------------------------------------------
// Match state per (user, RFP)
// ---------------------------------------------------------------------------

export const matchState = pgTable(
  "match_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rfpId: text("rfp_id").notNull(),
    // Bidding-tracker pipeline. null = not in the tracker.
    // 'saved' | 'in_progress' | 'bid_submitted' | 'won' | 'lost' | 'no_bid'
    status: text("status"),
    matchScore: real("match_score"),
    matchTier: text("match_tier"),
    winProbability: real("win_probability"),
    incumbentState: text("incumbent_state"), // 'likely' | 'open_field' | 'unknown'
    feedbackRating: text("feedback_rating"), // 'good' | 'bad'
    feedbackReason: text("feedback_reason"),
    feedbackAt: timestamp("feedback_at", { withTimezone: true }),
    // Bidding-tracker audit: timestamp of the last status transition.
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    // First time the user opened the RFP detail page. Drives the daily
    // roundup digest (unviewed >75% matches only) and any future "new
    // since last visit" UI. Set once and never cleared.
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_match_state_user_status").on(t.userId, t.status),
    index("idx_match_state_user_viewed").on(t.userId, t.viewedAt),
    unique("uq_match_state_user_rfp").on(t.userId, t.rfpId),
  ],
);

// ---------------------------------------------------------------------------
// RFP tasks — per (user, RFP) checklist for the bidding tracker.
// On first save of an RFP, a default 7-item template is seeded (is_custom=false);
// users can add/edit/delete any items afterward.
// ---------------------------------------------------------------------------

export const rfpTasks = pgTable(
  "rfp_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rfpId: text("rfp_id").notNull(),
    label: text("label").notNull(),
    dueDate: date("due_date"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
    isCustom: boolean("is_custom").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_rfp_tasks_user_rfp").on(t.userId, t.rfpId),
  ],
);

// ---------------------------------------------------------------------------
// Generated documents (POE, proposals)
// ---------------------------------------------------------------------------

export const generatedDocuments = pgTable(
  "generated_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rfpId: text("rfp_id").notNull(),
    kind: text("kind").notNull(), // 'plan_of_execution' | 'proposal'
    content: text("content").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_generated_user_rfp").on(t.userId, t.rfpId)],
);

// ---------------------------------------------------------------------------
// RFP cache — denormalized read view of webscraping v2 manifests for matching.
// Field population varies by source_id; see webscraping/v2/COVERAGE.md.
// Empty/null fields mean "unknown" not "zero".
// ---------------------------------------------------------------------------

export const rfpCache = pgTable(
  "rfp_cache",
  {
    id: text("id").primaryKey(), // matches scraped event id
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // One-sentence LLM-generated scope (see scripts/tag-rfp-naics.ts).
    // Lives alongside `description` rather than replacing it so the raw
    // agency text stays available for explainability/audit.
    scopeSummary: text("scope_summary"),
    agency: text("agency"),
    location: text("location"),
    deadline: timestamp("deadline", { withTimezone: true }),
    estimatedValueUsd: bigint("estimated_value_usd", { mode: "number" }),
    // LLM-extracted (Cal eProcure today; PlanetBids/BidSync empty)
    capabilities: text("capabilities").array(),
    naicsCodes: text("naics_codes").array(),
    certificationsRequired: text("certifications_required").array(),
    licensesRequired: text("licenses_required").array(),
    setAsideLockout: text("set_aside_lockout").array(),
    deliverables: text("deliverables").array(),
    requiresPastGovExp: boolean("requires_past_gov_exp"),
    incumbentVendor: text("incumbent_vendor"),
    incumbentContractEnd: date("incumbent_contract_end"),
    // Market intel (PlanetBids today; Cal eProcure / BidSync empty)
    prospectiveBidderCount: integer("prospective_bidder_count"),
    bidCount: integer("bid_count"),
    bidAmountsCents: bigint("bid_amounts_cents", { mode: "number" }).array(),
    winningBidCents: bigint("winning_bid_cents", { mode: "number" }),
    winningVendorFingerprint: text("winning_vendor_fingerprint"),
    // Semantic
    embedding: vector("embedding", { dimensions: 1024 }),
    // Raw payload from manifest
    raw: jsonb("raw"),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_rfp_cache_embedding").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("idx_rfp_cache_deadline").on(t.deadline),
    index("idx_rfp_cache_agency").on(t.agency),
    index("idx_rfp_cache_source").on(t.sourceId),
    index("idx_rfp_cache_winning_vendor").on(t.winningVendorFingerprint),
  ],
);

// ---------------------------------------------------------------------------
// RFP bidders — normalized fan-out of prospective_bidders + bid_results.
// Used for vendor history queries, agency_relationships auto-populate,
// "you've competed against" signals.
// ---------------------------------------------------------------------------

export const rfpBidders = pgTable(
  "rfp_bidders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rfpId: text("rfp_id")
      .notNull()
      .references(() => rfpCache.id, { onDelete: "cascade" }),
    vendorFingerprint: text("vendor_fingerprint"), // null until vendor index resolves
    vendorName: text("vendor_name").notNull(),
    role: text("role").notNull(), // 'prospective' | 'bidder' | 'winner'
    bidAmountCents: bigint("bid_amount_cents", { mode: "number" }),
    responsive: boolean("responsive"),
    classification: text("classification"), // PlanetBids: 'Bidder' | 'Subcontractor' | 'Plan Room'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_rfp_bidders_rfp").on(t.rfpId),
    index("idx_rfp_bidders_fingerprint").on(t.vendorFingerprint),
    // Trigram index on vendor_name added in a manual SQL migration —
    // Drizzle doesn't yet have first-class gin_trgm_ops support.
  ],
);

// ---------------------------------------------------------------------------
// Vendors — mirrors webscraping vendor index for join queries
// ---------------------------------------------------------------------------

export const vendors = pgTable("vendors", {
  fingerprint: text("fingerprint").primaryKey(),
  name: text("name").notNull(),
  state: text("state"),
  city: text("city"),
  certifications: text("certifications").array(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  bidCount: integer("bid_count").default(0),
  winCount: integer("win_count").default(0),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Type helpers — exported so API code can use Drizzle's inferred types.
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type PendingUser = typeof pendingUsers.$inferSelect;
export type NewPendingUser = typeof pendingUsers.$inferInsert;

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

export type Specialty = typeof specialties.$inferSelect;
export type Capability = typeof capabilities.$inferSelect;
export type License = typeof licenses.$inferSelect;
export type Certification = typeof certifications.$inferSelect;
export type WorkArea = typeof workAreas.$inferSelect;
export type AgencyRelationship = typeof agencyRelationships.$inferSelect;

export type Contract = typeof contracts.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type MatchState = typeof matchState.$inferSelect;
export type RfpTask = typeof rfpTasks.$inferSelect;
export type NewRfpTask = typeof rfpTasks.$inferInsert;

export type RfpCacheRow = typeof rfpCache.$inferSelect;
export type RfpBidder = typeof rfpBidders.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;

// Marker so Drizzle picks up the SQL-tagged dependency in this module.
// Without this, `sql` would be flagged as unused — but we may add raw SQL
// (e.g. trigram indexes, partial-index predicates) in future migrations.
export const _sql = sql;
