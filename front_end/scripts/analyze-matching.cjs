const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const s3 = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: "AKIAX4YLG4KAF6CC3OV2",
    secretAccessKey: "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",
  },
});

async function fetchS3(key) {
  const cmd = new GetObjectCommand({ Bucket: "civitas-uploads", Key: key });
  const resp = await s3.send(cmd);
  return resp.Body.transformToString("utf-8");
}

// Sierra West profile
const profile = {
  companyName: "Sierra West Infrastructure, Inc.",
  industry: ["Construction", "Public Infrastructure Construction"],
  sizeStatus: ["SBA Small Business", "Emerging Small Business (ESB)"],
  certifications: ["SB", "DBE", "MBE", "California SB-PW"],
  clearances: [],
  naicsCodes: ["236220", "237310", "237990", "238990"],
  workCities: ["Sacramento", "San Jose", "Oakland", "Fresno", "Stockton", "Modesto"],
  workCounties: ["Sacramento", "Santa Clara", "Alameda", "San Joaquin", "Stanislaus", "Fresno"],
  capabilities: [
    "Roadway and bridge construction",
    "Municipal infrastructure upgrades",
    "Concrete foundations",
    "ADA sidewalk installations",
    "Stormwater drainage systems",
    "Public facility renovations",
    "Grading and paving",
  ],
  agencyExperience: [
    "Caltrans",
    "City of Sacramento Public Works",
    "Santa Clara County Roads & Airports Department",
    "California Department of General Services",
    "University of California Capital Projects",
  ],
  contractTypes: ["Fixed Price", "Design-Bid-Build", "Job Order Contracting (JOC)", "Task Order / IDIQ", "Public Works Competitive Bid"],
  contractCount: 3,
  totalPastContractValue: "$13,100,000",
  pastPerformance: "Completed multiple municipal and state infrastructure projects.",
  strategicGoals: "Expand public infrastructure construction services across Central and Northern California.",
  technologyStack: [],
  maxSingleContractValue: "$5,800,000",
};

// Replicate inferIndustry from events/route.ts
function inferIndustry(department, title, description) {
  const text = `${department} ${title || ""} ${description || ""}`.toLowerCase();
  const d = department.toLowerCase();
  if (text.match(/\bwanted\s+to\s+lease\b/) || text.match(/\blease\s+(office|warehouse|space|property)\b/)) return "Real Estate & Leasing";
  if (text.match(/\b(software|saas|cloud|cyber|data\s*base|network|telecom|it\s+consult|electronic.*system|computer|digital)\b/)) return "IT Services";
  if (text.match(/\b(janitorial|cleaning|custodial|sanitation|housekeeping)\b/)) return "Facilities Maintenance";
  if (text.match(/\b(hvac|heating|ventilation|cooling|plumbing|elevator|generator|preventive\s+maintenance|equipment\s+maintenance)\b/)) return "Facilities Maintenance";
  if (text.match(/\b(construction|building\s+construct|demolition|renovation|roofing|concrete|masonry|paving|asphalt|grading|excavation|siding)\b/)) return "Construction";
  if (text.match(/\b(road|highway|bridge|pavement|culvert|striping|high\s+friction)\b/)) return "Construction";
  if (text.match(/\b(hazardous\s+waste|waste\s+removal|disposal|remediation|abatement|contamination|environmental\s+test)\b/)) return "Environmental Services";
  if (text.match(/\b(landscaping|grounds|irrigation|vegetation|tree\s+trimming|pest\s+control|weed)\b/)) return "Environmental Services";
  if (text.match(/\b(courier|delivery|shipping|freight|towing|transportation\s+service|moving\s+service)\b/)) return "Transportation";
  if (text.match(/\b(vehicle|fleet|automotive|truck|bus|tractor|trailer)\b/)) return "Equipment & Supplies";
  if (text.match(/\b(medical|clinical|patient|hospital|nursing|pharmacy|bio.?hazardous|cytox)\b/)) return "Healthcare";
  if (text.match(/\b(engineer|structural|civil|mechanical|geotechnical|survey|architect)\b/)) return "Engineering";
  if (text.match(/\b(security|guard|surveillance|patrol|alarm)\b/) && !text.includes("cyber")) return "Security";
  if (text.match(/\b(consult|advisory|strategy|assessment|audit)\b/)) return "Consulting";
  if (text.match(/\b(supply|supplies|equipment|materials|procurement|furnish|rental)\b/)) return "Equipment & Supplies";
  if (text.match(/\b(maintenance|repair)\b/)) return "Facilities Maintenance";
  if (d.includes("transportation") || d.includes("dot")) return "Transportation";
  if (d.includes("health")) return "Healthcare";
  if (d.includes("general services")) return "Facilities Maintenance";
  if (d.includes("technology")) return "IT Services";
  return "Government Services";
}

// Replicate inferCapabilities from events/route.ts
function inferCapabilities(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const caps = [];
  if (text.match(/\b(cybersecurity|infosec|security\s+assess|penetration|firewall)\b/)) caps.push("Cybersecurity");
  if (text.match(/\b(cloud|aws|azure|gcp|saas|iaas|migration)\b/)) caps.push("Cloud Services");
  if (text.match(/\b(software\s+dev|application\s+dev|custom\s+software|programming)\b/)) caps.push("Software Development");
  if (text.match(/\b(construction|general\s+contractor|demolition|grading|excavat)\b/)) caps.push("Building Construction");
  if (text.match(/\b(road|highway|paving|asphalt|bridge|pavement|striping|culvert|guardrail|sidewalk|curb|gutter)\b/)) caps.push("Road & Highway Construction");
  if (text.match(/\b(concrete|masonry|foundation|structural|rebar|formwork)\b/)) caps.push("Concrete & Masonry");
  if (text.match(/\b(renovation|remodel|rehabilitat|restoration|retrofit|siding|roofing|roof\s+replace|replace\w*\s+service|upgrade|moderniz)\b/)) caps.push("Renovation & Remodeling");
  if (text.match(/\b(civil\s+engineer|structural\s+engineer|geotechnical|survey|engineer\w*\s+service)\b/)) caps.push("Civil Engineering");
  if (text.match(/\b(electrical|wiring|power\s+distribut|lighting|generator|solar|high\s+voltage|switchgear|panel)\b/)) caps.push("Electrical Systems");
  if (text.match(/\b(plumbing|piping|water\s+system|sewer|drain|storm\s*water|catch\s*basin|inlet)\b/)) caps.push("Plumbing & Piping");
  if (text.match(/\b(janitorial|cleaning|custodial|sanitation|housekeeping)\b/)) caps.push("Janitorial & Cleaning");
  if (text.match(/\b(hvac|heating|ventilation|cooling|air\s+balanc|chiller|refrigerat)\b/)) caps.push("HVAC Services");
  if (text.match(/\b(facilit.*maintenance|preventive\s+maintenance|equipment\s+maintenance|repair\s+service|maintenance\s+and\s+repair|repair|replac\w+\s+and\s+repair)\b/)) caps.push("Facilities Maintenance & Repair");
  if (text.match(/\b(landscap|grounds|irrigation|vegetation|horticultur|tree\s+trim)\b/)) caps.push("Landscaping & Grounds");
  if (text.match(/\b(consult|advisory|strateg|assessment)\b/)) caps.push("Consulting & Advisory");
  if (text.match(/\b(vehicle|fleet|automotive|towing|truck|tractor)\b/)) caps.push("Vehicle & Fleet Services");
  if (text.match(/\b(remediat|environmental\s+clean|contamination|hazmat|abatement)\b/)) caps.push("Environmental Remediation");
  if (text.match(/\b(medical|clinical|health\s+service|nursing|pharmacy|bio.?hazard)\b/)) caps.push("Medical & Health Services");
  if (text.match(/\b(training|workshop|curriculum|instruction|education|course)\b/)) caps.push("Training & Support");
  if (text.match(/\b(staffing|temporary|recruiting|personnel|labor\s+service)\b/)) caps.push("Staffing & Recruiting");
  return caps;
}

(async () => {
  const eventsRaw = await fetchS3("scrapes/caleprocure/all_events.json");
  const events = JSON.parse(eventsRaw).events;
  const extractionsRaw = await fetchS3("scrapes/caleprocure/attachment_extractions.json");
  const extractions = JSON.parse(extractionsRaw);

  console.log("=== DATA OVERVIEW ===");
  console.log("Total events:", events.length);
  console.log("Events with extractions:", events.filter(e => extractions[e.event_id]).length);

  // Process events like the route does
  const rfps = events.map((e) => {
    const ext = extractions[e.event_id] || null;
    return {
      title: e.title || "Untitled",
      agency: e.department || "Unknown",
      industry: inferIndustry(e.department || "", e.title, e.description),
      naicsCodes: ext?.naics_codes?.length ? ext.naics_codes : [],
      capabilities: ext?.capabilities_required?.length ? ext.capabilities_required : inferCapabilities(e.title || "", e.description || ""),
      certifications: ext?.certifications_required?.length ? ext.certifications_required : [],
      description: (e.description || "").slice(0, 2000),
      location: ext?.location_details?.[0] || "California",
      clearancesRequired: ext?.clearances_required || [],
      setAsideTypes: ext?.set_aside_types || [],
    };
  });

  // Analyze: how many RFPs have each field populated?
  console.log("\n=== FIELD POPULATION RATES ===");
  console.log("Has NAICS codes:", rfps.filter(r => r.naicsCodes.length > 0).length, "/", rfps.length);
  console.log("Has capabilities:", rfps.filter(r => r.capabilities.length > 0).length, "/", rfps.length);
  console.log("Has certifications:", rfps.filter(r => r.certifications.length > 0).length, "/", rfps.length);
  console.log("Has clearances:", rfps.filter(r => r.clearancesRequired.length > 0).length, "/", rfps.length);
  console.log("Has set-asides:", rfps.filter(r => r.setAsideTypes.length > 0).length, "/", rfps.length);
  console.log("Has specific location:", rfps.filter(r => r.location !== "California").length, "/", rfps.length);

  // Industry distribution
  const industryDist = {};
  rfps.forEach(r => { industryDist[r.industry] = (industryDist[r.industry] || 0) + 1; });
  console.log("\n=== INDUSTRY DISTRIBUTION ===");
  Object.entries(industryDist).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`));

  // Construction-related RFPs deep dive
  const constructionRFPs = rfps.filter(r => r.industry === "Construction" || r.industry === "Engineering");
  console.log("\n=== CONSTRUCTION/ENGINEERING RFPs ===");
  console.log("Count:", constructionRFPs.length);
  constructionRFPs.slice(0, 10).forEach(r => {
    console.log("\n  Title:", r.title.substring(0, 80));
    console.log("  Agency:", r.agency);
    console.log("  Industry:", r.industry);
    console.log("  NAICS:", r.naicsCodes.join(", ") || "(none)");
    console.log("  Caps:", r.capabilities.join(", ") || "(none)");
    console.log("  Certs:", r.certifications.join(", ") || "(none)");
    console.log("  Location:", r.location);
  });

  // Profile capabilities vs RFP capabilities - the mismatch problem
  console.log("\n=== CAPABILITY VOCABULARY MISMATCH ===");
  console.log("Profile capabilities:", profile.capabilities);
  const allRfpCaps = new Set();
  rfps.forEach(r => r.capabilities.forEach(c => allRfpCaps.add(c)));
  console.log("\nAll unique RFP capabilities (" + allRfpCaps.size + "):");
  [...allRfpCaps].sort().forEach(c => console.log("  -", c));

  // Check: do ANY profile capabilities match ANY RFP capabilities?
  const profileCapLower = profile.capabilities.map(c => c.toLowerCase());
  const rfpCapLower = [...allRfpCaps].map(c => c.toLowerCase());
  const directMatches = profileCapLower.filter(pc => rfpCapLower.some(rc => rc === pc));
  console.log("\nDirect capability matches (profile vs RFP vocabulary):", directMatches.length);
  console.log("Profile terms:", profileCapLower);
  console.log("RFP terms sample:", rfpCapLower.slice(0, 15));

  // NAICS overlap check
  const allRfpNaics = new Set();
  rfps.forEach(r => r.naicsCodes.forEach(n => allRfpNaics.add(n)));
  console.log("\n=== NAICS CODES ===");
  console.log("Unique NAICS in RFPs:", allRfpNaics.size);
  console.log("Profile NAICS:", profile.naicsCodes);
  const naicsMatches = profile.naicsCodes.filter(pn => [...allRfpNaics].some(rn => rn.startsWith(pn.slice(0,3)) || pn.startsWith(rn.slice(0,3))));
  console.log("Profile NAICS with any prefix overlap in RFPs:", naicsMatches);
  console.log("All RFP NAICS codes:", [...allRfpNaics].sort());
})();
