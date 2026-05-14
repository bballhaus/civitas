// Seed lists for the onboarding wizard pickers (spec § 5).
//
// Free-text remains supported on every step; these lists exist to make the
// common cases one-click and to keep canonical_id values consistent across
// users so the matcher can do typed comparisons (binary license-class match,
// hard-cert disqualifier, etc.).
//
// Spec § 14 flagged the open questions about taxonomy depth — start small,
// expand as we onboard real contractors.

export const EMPLOYEE_BANDS = [
  { value: "1", label: "Just me" },
  { value: "2-10", label: "2-10" },
  { value: "11-50", label: "11-50" },
  { value: "51-200", label: "51-200" },
  { value: "201-1000", label: "201-1000" },
  { value: "1000+", label: "1000+" },
] as const;

// Common contractor specialties as quick-pick suggestions. Free-text is the
// authoritative input — the matcher embeds whatever the user types.
export const SPECIALTY_SUGGESTIONS = [
  "concrete flatwork",
  "asphalt paving",
  "structural steel erection",
  "HVAC installation",
  "electrical wiring",
  "plumbing installation",
  "roofing",
  "drywall and finishing",
  "landscape design and installation",
  "roadway construction",
  "bridge construction",
  "stormwater management",
  "fiber optic installation",
  "security systems integration",
  "fire sprinkler systems",
  "solar panel installation",
  "interior renovation",
  "ADA compliance retrofits",
  "site grading and excavation",
  "demolition",
];

// California CSLB license classes (the matching-critical ones). Spec § 14
// flagged this as needing completion before launch; this covers the common
// classes seen on the RFPs in the catalog today.
export const LICENSE_CLASSES = [
  { value: "A", label: "A — General Engineering" },
  { value: "B", label: "B — General Building" },
  { value: "B-2", label: "B-2 — Residential Remodeling" },
  { value: "C-2", label: "C-2 — Insulation & Acoustical" },
  { value: "C-4", label: "C-4 — Boiler, Hot-Water Heating & Steam Fitting" },
  { value: "C-5", label: "C-5 — Framing & Rough Carpentry" },
  { value: "C-6", label: "C-6 — Cabinet, Millwork & Finish Carpentry" },
  { value: "C-7", label: "C-7 — Low Voltage Systems" },
  { value: "C-8", label: "C-8 — Concrete" },
  { value: "C-9", label: "C-9 — Drywall" },
  { value: "C-10", label: "C-10 — Electrical" },
  { value: "C-11", label: "C-11 — Elevator" },
  { value: "C-12", label: "C-12 — Earthwork & Paving" },
  { value: "C-13", label: "C-13 — Fencing" },
  { value: "C-15", label: "C-15 — Flooring & Floor Covering" },
  { value: "C-16", label: "C-16 — Fire Protection" },
  { value: "C-17", label: "C-17 — Glazing" },
  { value: "C-20", label: "C-20 — HVAC" },
  { value: "C-21", label: "C-21 — Building Moving / Demolition" },
  { value: "C-22", label: "C-22 — Asbestos Abatement" },
  { value: "C-23", label: "C-23 — Ornamental Metals" },
  { value: "C-27", label: "C-27 — Landscaping" },
  { value: "C-28", label: "C-28 — Locksmith" },
  { value: "C-29", label: "C-29 — Masonry" },
  { value: "C-31", label: "C-31 — Construction Zone Traffic Control" },
  { value: "C-32", label: "C-32 — Parking & Highway Improvement" },
  { value: "C-33", label: "C-33 — Painting & Decorating" },
  { value: "C-34", label: "C-34 — Pipeline" },
  { value: "C-35", label: "C-35 — Lathing & Plastering" },
  { value: "C-36", label: "C-36 — Plumbing" },
  { value: "C-38", label: "C-38 — Refrigeration" },
  { value: "C-39", label: "C-39 — Roofing" },
  { value: "C-42", label: "C-42 — Sanitation Systems" },
  { value: "C-43", label: "C-43 — Sheet Metal" },
  { value: "C-45", label: "C-45 — Sign" },
  { value: "C-46", label: "C-46 — Solar" },
  { value: "C-47", label: "C-47 — General Manufactured Housing" },
  { value: "C-49", label: "C-49 — Tree & Palm" },
  { value: "C-50", label: "C-50 — Reinforcing Steel" },
  { value: "C-51", label: "C-51 — Structural Steel" },
  { value: "C-53", label: "C-53 — Swimming Pool" },
  { value: "C-54", label: "C-54 — Tile (Ceramic & Mosaic)" },
  { value: "C-55", label: "C-55 — Water Conditioning" },
  { value: "C-57", label: "C-57 — Well Drilling" },
  { value: "C-60", label: "C-60 — Welding" },
  { value: "C-61", label: "C-61 — Limited Specialty" },
  // Non-CSLB professional credentials that gate certain RFPs.
  { value: "PE", label: "PE — Professional Engineer" },
  { value: "DIR", label: "DIR — Public Works Registration" },
] as const;

// "Hard" certifications can disqualify (set-aside lockouts, mandatory creds).
// "Soft" certifications are bonus signals (preferred-vendor programs, ISOs).
// `canonicalId` matches the canonicalization map in
// front_end/src/lib/rfp-matching.ts so matcher v2 can compare cleanly.
export const HARD_CERTIFICATIONS = [
  { canonicalId: "sb", displayName: "Small Business (SB)" },
  { canonicalId: "dvbe", displayName: "Disabled Veteran Business Enterprise (DVBE)" },
  { canonicalId: "wbe", displayName: "Woman-Owned Business (WBE)" },
  { canonicalId: "mbe", displayName: "Minority-Owned Business (MBE)" },
  { canonicalId: "dbe", displayName: "Disadvantaged Business Enterprise (DBE)" },
  { canonicalId: "lbe", displayName: "Local Business Enterprise (LBE)" },
  { canonicalId: "8a", displayName: "8(a) Business Development" },
  { canonicalId: "hubzone", displayName: "HUBZone" },
  { canonicalId: "sdvosb", displayName: "Service-Disabled Veteran-Owned Small Business" },
  { canonicalId: "wosb", displayName: "Woman-Owned Small Business (WOSB)" },
] as const;

export const SOFT_CERTIFICATIONS = [
  { canonicalId: "iso_9001", displayName: "ISO 9001 (Quality Management)" },
  { canonicalId: "iso_14001", displayName: "ISO 14001 (Environmental)" },
  { canonicalId: "iso_27001", displayName: "ISO 27001 (Information Security)" },
  { canonicalId: "fedramp", displayName: "FedRAMP" },
  { canonicalId: "cmmi", displayName: "CMMI" },
  { canonicalId: "leed", displayName: "LEED Accredited Professional" },
  { canonicalId: "osha_30", displayName: "OSHA 30-Hour" },
  { canonicalId: "soc_2", displayName: "SOC 2" },
  { canonicalId: "nist_800_171", displayName: "NIST 800-171" },
  { canonicalId: "cmmc", displayName: "CMMC" },
] as const;

// California metros mirror the groups in Matching-Algorithm.md so the matcher
// can score metro-level overlap without a separate lookup.
export const CA_METROS = [
  "Bay Area",
  "Greater Los Angeles",
  "Sacramento Metro",
  "San Diego Area",
  "Inland Empire",
  "Central Valley",
  "Central Coast",
  "North Coast",
] as const;

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
] as const;

export const DURATION_PREFS = [
  { value: "short", label: "Short jobs (≤ 6 months)" },
  { value: "any", label: "Any duration" },
  { value: "retention_ok", label: "Multi-year / retention OK" },
] as const;

export const COMPLEXITY_PREFS = [
  { value: "simple_only", label: "Simple, single-trade only" },
  { value: "any", label: "Any complexity" },
  { value: "any_with_subs", label: "Any — happy to bring subs" },
] as const;

export const PRIME_VS_SUB = [
  { value: "prime_only", label: "Prime only" },
  { value: "open_to_sub", label: "Open to both" },
  { value: "sub_only", label: "Sub only" },
] as const;

export const GOV_EXPERIENCE = [
  { value: "none", label: "No prior government experience" },
  { value: "local", label: "City / County contracts" },
  { value: "state", label: "State contracts" },
  { value: "federal", label: "Federal contracts" },
] as const;

// Common CA agencies for the seed list on step 8 (Capacity & history).
// Same canonical_ids feed the matcher's agency-experience scorer.
export const COMMON_AGENCIES = [
  { canonical: "caltrans", display: "Caltrans (Dept. of Transportation)" },
  { canonical: "dgs", display: "DGS (Dept. of General Services)" },
  { canonical: "cdcr", display: "CDCR (Dept. of Corrections)" },
  { canonical: "csu", display: "California State University" },
  { canonical: "uc", display: "University of California" },
  { canonical: "lausd", display: "Los Angeles Unified School District" },
  { canonical: "sfusd", display: "San Francisco Unified School District" },
  { canonical: "sdusd", display: "San Diego Unified School District" },
  { canonical: "la_city", display: "City of Los Angeles" },
  { canonical: "sf_city", display: "City and County of San Francisco" },
  { canonical: "san_diego_city", display: "City of San Diego" },
  { canonical: "sacramento_city", display: "City of Sacramento" },
  { canonical: "metro_la", display: "LA Metro" },
  { canonical: "bart", display: "BART" },
  { canonical: "valley_water", display: "Valley Water" },
] as const;

export const TOTAL_STEPS = 9;
