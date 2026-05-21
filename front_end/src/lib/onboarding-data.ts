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

// Order matters here: open-ended / "any" options always come last so a
// scanning user reads the specific picks first. Matches the convention on
// the existing /profile page.
export const DURATION_PREFS = [
  { value: "short", label: "Short jobs (≤ 6 months)" },
  { value: "retention_ok", label: "Multi-year / retention OK" },
  { value: "any", label: "Any duration" },
] as const;

export const COMPLEXITY_PREFS = [
  { value: "simple_only", label: "Simple, single-trade only" },
  { value: "any_with_subs", label: "Large-scale projects with subs" },
  { value: "any", label: "Any complexity" },
] as const;

// Multi-select in the v2 wizard — a contractor may bid as both prime and
// sub. Stored as a text[] on profiles.prime_vs_sub.
export const PRIME_VS_SUB = [
  { value: "prime", label: "Prime" },
  { value: "sub", label: "Sub" },
] as const;

// Multi-select. A contractor with state experience hasn't necessarily done
// federal work, so we don't model these as a strict hierarchy.
export const GOV_EXPERIENCE = [
  { value: "none", label: "No prior government experience" },
  { value: "local", label: "City / County / Municipal" },
  { value: "state", label: "State" },
  { value: "federal", label: "Federal" },
] as const;

// California public agencies — comprehensive seed list for the step-8
// agency picker. canonical IDs feed the matcher's agency-experience
// scorer; display strings are what the user sees.
//
// Grouped here as one flat array (the UI buckets it via the prefix
// helper); duplicates of the older subset are intentional so historical
// seeds keep working.
export const COMMON_AGENCIES = [
  // State — transportation / infrastructure
  { canonical: "caltrans", display: "Caltrans (Dept. of Transportation)" },
  { canonical: "hsr", display: "California High-Speed Rail Authority" },
  { canonical: "calhsr", display: "California High-Speed Rail Authority" },
  { canonical: "chp", display: "California Highway Patrol" },
  { canonical: "dmv", display: "California DMV" },
  // State — general government
  { canonical: "dgs", display: "DGS (Dept. of General Services)" },
  { canonical: "calhr", display: "CalHR (Human Resources)" },
  { canonical: "ftb", display: "Franchise Tax Board" },
  { canonical: "cdtfa", display: "CDTFA (Tax and Fee Administration)" },
  { canonical: "edd", display: "Employment Development Dept." },
  { canonical: "sos", display: "Secretary of State" },
  { canonical: "controller", display: "State Controller" },
  { canonical: "treasurer", display: "State Treasurer" },
  { canonical: "doj", display: "Dept. of Justice" },
  { canonical: "calpers", display: "CalPERS" },
  { canonical: "calstrs", display: "CalSTRS" },
  { canonical: "lottery", display: "California State Lottery" },
  { canonical: "abc", display: "Alcoholic Beverage Control" },
  // State — health & human services
  { canonical: "cdph", display: "Dept. of Public Health" },
  { canonical: "dhcs", display: "Dept. of Health Care Services" },
  { canonical: "cdss", display: "Dept. of Social Services" },
  { canonical: "cdds", display: "Dept. of Developmental Services" },
  { canonical: "dsh", display: "Dept. of State Hospitals" },
  { canonical: "cda", display: "Dept. of Aging" },
  // State — corrections & public safety
  { canonical: "cdcr", display: "CDCR (Dept. of Corrections)" },
  { canonical: "cal_oes", display: "Cal OES (Emergency Services)" },
  { canonical: "cal_fire", display: "CAL FIRE" },
  // State — environment / natural resources
  { canonical: "cal_epa", display: "CalEPA" },
  { canonical: "carb", display: "California Air Resources Board" },
  { canonical: "calrecycle", display: "CalRecycle" },
  { canonical: "cec", display: "California Energy Commission" },
  { canonical: "cpuc", display: "California Public Utilities Commission" },
  { canonical: "dwr", display: "Dept. of Water Resources" },
  { canonical: "swrcb", display: "State Water Resources Control Board" },
  { canonical: "dfw", display: "Dept. of Fish and Wildlife" },
  { canonical: "cdfa", display: "Dept. of Food and Agriculture" },
  { canonical: "dpr", display: "Dept. of Parks and Recreation" },
  { canonical: "calfire", display: "CAL FIRE" },
  // Education — university systems
  { canonical: "csu", display: "California State University (system)" },
  { canonical: "uc", display: "University of California (system)" },
  { canonical: "cccco", display: "California Community Colleges Chancellor's Office" },
  // Education — largest K-12 districts
  { canonical: "lausd", display: "Los Angeles Unified School District" },
  { canonical: "sdusd", display: "San Diego Unified School District" },
  { canonical: "lbusd", display: "Long Beach Unified School District" },
  { canonical: "fresno_usd", display: "Fresno Unified School District" },
  { canonical: "elk_grove_usd", display: "Elk Grove Unified School District" },
  { canonical: "capistrano_usd", display: "Capistrano Unified School District" },
  { canonical: "sfusd", display: "San Francisco Unified School District" },
  { canonical: "santa_ana_usd", display: "Santa Ana Unified School District" },
  { canonical: "sweetwater_usd", display: "Sweetwater Union High School District" },
  { canonical: "garden_grove_usd", display: "Garden Grove Unified School District" },
  { canonical: "corona_norco_usd", display: "Corona-Norco Unified School District" },
  { canonical: "oakland_usd", display: "Oakland Unified School District" },
  { canonical: "sacramento_city_usd", display: "Sacramento City Unified School District" },
  { canonical: "san_juan_usd", display: "San Juan Unified School District" },
  { canonical: "moreno_valley_usd", display: "Moreno Valley Unified School District" },
  { canonical: "fontana_usd", display: "Fontana Unified School District" },
  // Counties — largest
  { canonical: "la_county", display: "County of Los Angeles" },
  { canonical: "san_diego_county", display: "County of San Diego" },
  { canonical: "orange_county", display: "County of Orange" },
  { canonical: "riverside_county", display: "County of Riverside" },
  { canonical: "san_bernardino_county", display: "County of San Bernardino" },
  { canonical: "santa_clara_county", display: "County of Santa Clara" },
  { canonical: "alameda_county", display: "County of Alameda" },
  { canonical: "sacramento_county", display: "County of Sacramento" },
  { canonical: "contra_costa_county", display: "County of Contra Costa" },
  { canonical: "fresno_county", display: "County of Fresno" },
  { canonical: "kern_county", display: "County of Kern" },
  { canonical: "san_francisco_city_county", display: "City & County of San Francisco" },
  { canonical: "ventura_county", display: "County of Ventura" },
  { canonical: "san_mateo_county", display: "County of San Mateo" },
  { canonical: "san_joaquin_county", display: "County of San Joaquin" },
  { canonical: "stanislaus_county", display: "County of Stanislaus" },
  { canonical: "sonoma_county", display: "County of Sonoma" },
  { canonical: "tulare_county", display: "County of Tulare" },
  { canonical: "santa_barbara_county", display: "County of Santa Barbara" },
  { canonical: "solano_county", display: "County of Solano" },
  { canonical: "monterey_county", display: "County of Monterey" },
  { canonical: "placer_county", display: "County of Placer" },
  { canonical: "marin_county", display: "County of Marin" },
  { canonical: "el_dorado_county", display: "County of El Dorado" },
  { canonical: "yolo_county", display: "County of Yolo" },
  { canonical: "imperial_county", display: "County of Imperial" },
  // Cities — largest
  { canonical: "la_city", display: "City of Los Angeles" },
  { canonical: "san_diego_city", display: "City of San Diego" },
  { canonical: "san_jose_city", display: "City of San Jose" },
  { canonical: "fresno_city", display: "City of Fresno" },
  { canonical: "sacramento_city", display: "City of Sacramento" },
  { canonical: "long_beach_city", display: "City of Long Beach" },
  { canonical: "oakland_city", display: "City of Oakland" },
  { canonical: "bakersfield_city", display: "City of Bakersfield" },
  { canonical: "anaheim_city", display: "City of Anaheim" },
  { canonical: "stockton_city", display: "City of Stockton" },
  { canonical: "riverside_city", display: "City of Riverside" },
  { canonical: "santa_ana_city", display: "City of Santa Ana" },
  { canonical: "irvine_city", display: "City of Irvine" },
  { canonical: "chula_vista_city", display: "City of Chula Vista" },
  { canonical: "fremont_city", display: "City of Fremont" },
  { canonical: "san_bernardino_city", display: "City of San Bernardino" },
  { canonical: "modesto_city", display: "City of Modesto" },
  { canonical: "fontana_city", display: "City of Fontana" },
  { canonical: "oxnard_city", display: "City of Oxnard" },
  { canonical: "moreno_valley_city", display: "City of Moreno Valley" },
  { canonical: "huntington_beach_city", display: "City of Huntington Beach" },
  { canonical: "glendale_city", display: "City of Glendale" },
  { canonical: "santa_clarita_city", display: "City of Santa Clarita" },
  { canonical: "garden_grove_city", display: "City of Garden Grove" },
  { canonical: "santa_rosa_city", display: "City of Santa Rosa" },
  { canonical: "ontario_city", display: "City of Ontario" },
  { canonical: "rancho_cucamonga_city", display: "City of Rancho Cucamonga" },
  { canonical: "elk_grove_city", display: "City of Elk Grove" },
  { canonical: "corona_city", display: "City of Corona" },
  { canonical: "palmdale_city", display: "City of Palmdale" },
  { canonical: "salinas_city", display: "City of Salinas" },
  { canonical: "pomona_city", display: "City of Pomona" },
  { canonical: "torrance_city", display: "City of Torrance" },
  { canonical: "hayward_city", display: "City of Hayward" },
  { canonical: "escondido_city", display: "City of Escondido" },
  { canonical: "sunnyvale_city", display: "City of Sunnyvale" },
  { canonical: "pasadena_city", display: "City of Pasadena" },
  { canonical: "fullerton_city", display: "City of Fullerton" },
  { canonical: "orange_city", display: "City of Orange" },
  { canonical: "thousand_oaks_city", display: "City of Thousand Oaks" },
  { canonical: "visalia_city", display: "City of Visalia" },
  { canonical: "roseville_city", display: "City of Roseville" },
  { canonical: "concord_city", display: "City of Concord" },
  { canonical: "santa_clara_city", display: "City of Santa Clara" },
  { canonical: "vallejo_city", display: "City of Vallejo" },
  { canonical: "berkeley_city", display: "City of Berkeley" },
  // Transit & transportation authorities
  { canonical: "metro_la", display: "LA Metro" },
  { canonical: "octa", display: "Orange County Transportation Authority" },
  { canonical: "rctc", display: "Riverside County Transportation Commission" },
  { canonical: "sbcta", display: "San Bernardino County Transportation Authority" },
  { canonical: "vta", display: "VTA (Santa Clara)" },
  { canonical: "bart", display: "BART" },
  { canonical: "ac_transit", display: "AC Transit" },
  { canonical: "muni", display: "SFMTA / MUNI" },
  { canonical: "sfmta", display: "SFMTA / MUNI" },
  { canonical: "sdmts", display: "San Diego MTS" },
  { canonical: "nctd", display: "North County Transit District" },
  { canonical: "samtrans", display: "SamTrans" },
  { canonical: "caltrain", display: "Caltrain" },
  { canonical: "smart", display: "SMART (Sonoma-Marin)" },
  { canonical: "sandag", display: "SANDAG" },
  { canonical: "mtc", display: "Metropolitan Transportation Commission" },
  { canonical: "scag", display: "SCAG" },
  // Water / utilities
  { canonical: "ladwp", display: "LADWP" },
  { canonical: "mwdsc", display: "Metropolitan Water District of Southern California" },
  { canonical: "sfpuc", display: "SFPUC" },
  { canonical: "ebmud", display: "EBMUD" },
  { canonical: "valley_water", display: "Valley Water (Santa Clara)" },
  { canonical: "ocwd", display: "Orange County Water District" },
  { canonical: "scvwd", display: "Santa Clara Valley Water District" },
  { canonical: "iid", display: "Imperial Irrigation District" },
  { canonical: "smud", display: "SMUD (Sacramento)" },
  { canonical: "smart_grid", display: "California ISO" },
  // Ports & airports
  { canonical: "port_la", display: "Port of Los Angeles" },
  { canonical: "port_long_beach", display: "Port of Long Beach" },
  { canonical: "port_oakland", display: "Port of Oakland" },
  { canonical: "lawa", display: "Los Angeles World Airports (LAX)" },
  { canonical: "sfo", display: "SFO Airport" },
  { canonical: "san_diego_airport", display: "San Diego International Airport" },
] as const;

export const TOTAL_STEPS = 9;

// Per-step UI metadata — title shown in the card header, short label in the
// breadcrumb pip, blurb under the title, and icon key for the StepIcon
// dispatcher. Per-step page.tsx renders this; per-step Steps.tsx renders
// only the inputs.
export const STEP_META = [
  {
    short: "Identity",
    title: "Tell us about your company",
    blurb:
      "Just the basics. We use these to filter RFPs by size and to introduce you on generated proposals.",
    icon: "identity",
  },
  {
    short: "Specialties",
    title: "What's your bread and butter?",
    blurb:
      "Your two or three core specialties — the single biggest signal we use to match RFPs. Be specific.",
    icon: "specialty",
  },
  {
    short: "Capabilities",
    title: "What else can you do?",
    blurb:
      "Broader than specialties. Anything you can take on if the RFP calls for it.",
    icon: "capabilities",
  },
  {
    short: "Licenses",
    title: "Licenses you hold",
    blurb:
      "License classes act as binary gates. Missing one routes the RFP to your sub track.",
    icon: "license",
  },
  {
    short: "Certifications",
    title: "Certifications",
    blurb:
      "Hard certifications (DVBE, 8(a)) can qualify or disqualify outright. Soft certifications (ISO, CMMI) are bonus signals.",
    icon: "certification",
  },
  {
    short: "Geography",
    title: "Where do you work?",
    blurb:
      "Cities, counties, metros, or whole states. Lock anywhere you absolutely won't travel outside.",
    icon: "geography",
  },
  {
    short: "Scope",
    title: "Scope & duration",
    blurb:
      "What size jobs do you take? RFPs outside your band get scored lower so they don't crowd your dashboard.",
    icon: "scope",
  },
  {
    short: "Capacity",
    title: "Capacity & history",
    blurb:
      "How you bid and which agencies you've worked with. Used to weight matches and detect incumbent-protected RFPs.",
    icon: "capacity",
  },
  {
    short: "Review",
    title: "Almost done",
    blurb:
      "Here's what we'll use to match you. You can edit any of this from your profile later.",
    icon: "review",
  },
] as const;
