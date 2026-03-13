# Example Test Profiles

This page provides ready-made company profiles for testing Civitas. Each profile includes a company overview PDF and 3-5 past proposal PDFs that can be uploaded through the app's onboarding flow.

**How to use:** Create a test account, then upload the proposal PDFs on the Upload page. The system will extract metadata and build the company profile automatically. You can then verify the extracted profile matches the expected values below.

---

## 1. Sierra West Infrastructure, Inc.

**Industry:** Public Infrastructure Construction
**Size / Status:** SBA Small Business, Emerging Small Business (ESB)

### Test Files

| File | Purpose |
|---|---|
| [sierra_west_company_profile.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/sierra-west-infrastructure/sierra_west_company_profile.pdf) | Company profile (reference — do not upload) |
| [proposal_caltrans_drainage_upgrade.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/sierra-west-infrastructure/proposal_caltrans_drainage_upgrade.pdf) | Proposal: Caltrans Highway 99 drainage rehab ($5.8M) |
| [proposal_sacramento_sidewalk_project.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/sierra-west-infrastructure/proposal_sacramento_sidewalk_project.pdf) | Proposal: Sacramento ADA sidewalk improvements ($3.2M) |
| [proposal_santa_clara_facility_renovation.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/sierra-west-infrastructure/proposal_santa_clara_facility_renovation.pdf) | Proposal: Santa Clara County facility renovation ($4.1M) |

### Expected Extracted Profile

After uploading the 3 proposals, the system should extract a profile approximately matching:

| Field | Expected Values |
|---|---|
| **Company Name** | Sierra West Infrastructure |
| **Industry** | Construction |
| **Certifications** | SB, DBE, MBE, California SB-PW |
| **Clearances** | OSHA-30, SAM.gov Active, CA DIR Public Works Registration |
| **NAICS Codes** | 236220, 237310, 237990, 238990 |
| **Work Cities** | Sacramento, San Jose, Oakland, Fresno, Stockton, Modesto |
| **Work Counties** | Sacramento, Santa Clara, Alameda, San Joaquin, Stanislaus, Fresno |
| **Capabilities** | Roadway/bridge construction, municipal infrastructure, concrete foundations, ADA sidewalk installations, stormwater drainage, public facility renovations, grading and paving |
| **Agency Experience** | Caltrans, City of Sacramento Public Works, Santa Clara County Roads & Airports Dept, CA DGS, UC Capital Projects |
| **Contract Types** | Fixed Price, Design-Bid-Build, JOC, Task Order / IDIQ, Public Works Competitive Bid |
| **Total Contract Value** | ~$13.1M (across 3 proposals) |

### What to Verify

- Profile fields populated from the 3 proposals (not the company profile PDF)
- Match score appears for construction/infrastructure RFPs on the dashboard
- High scores expected for: Caltrans projects, Sacramento-area construction, ADA/sidewalk work, drainage/stormwater projects
- Lower scores expected for: IT services, consulting, healthcare, unrelated industries

---

## 2. Pacific Habitat Restoration & Environmental Services

**Industry:** Environmental Restoration & Ecological Construction
**Size / Status:** SBA Small Business, Woman-Owned Small Business (WOSB)

### Test Files

| File | Purpose |
|---|---|
| [Pacific Habitat Restoration & Environmental Services – Company Profile.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/pacific-habitat-restoration/Pacific%20Habitat%20Restoration%20%26%20Environmental%20Services%20%E2%80%93%20Company%20Profile.pdf) | Company profile (reference — do not upload) |
| [Proposal – Trinity River Habitat Restoration Project.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/pacific-habitat-restoration/Proposal%20%E2%80%93%20Trinity%20River%20Habitat%20Restoration%20Project.pdf) | Proposal: U.S. Forest Service riparian restoration ($1.9M) |
| [Proposal – Humboldt Coastal Wetland Rehabilitation.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/pacific-habitat-restoration/Proposal%20%E2%80%93%20Humboldt%20Coastal%20Wetland%20Rehabilitation.pdf) | Proposal: CA Coastal Commission wetland restoration ($2.3M) |
| [Proposal – Sierra Nevada Meadow Restoration Initiative.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/pacific-habitat-restoration/Proposal%20%E2%80%93%20Sierra%20Nevada%20Meadow%20Restoration%20Initiative.pdf) | Proposal: BLM meadow hydrology restoration ($1.4M) |
| [Proposal – Northern California Wildfire Rehabilitation Project.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/pacific-habitat-restoration/Proposal%20%E2%80%93%20Northern%20California%20Wildfire%20Rehabilitation%20Project.pdf) | Proposal: CDFW post-wildfire erosion control & habitat restoration ($2.0M) |

### Expected Extracted Profile

After uploading the 4 proposals, the system should extract a profile approximately matching:

| Field | Expected Values |
|---|---|
| **Company Name** | Pacific Habitat Restoration & Environmental Services |
| **Industry** | Environmental Services |
| **Certifications** | WOSB, SDB, CERP, CA DIR Public Works Registration |
| **Clearances** | OSHA-30, SAM.gov Active, CDFW Habitat Restoration Contractor |
| **NAICS Codes** | 541620, 562910, 237990, 115310 |
| **Work Cities** | Arcata, Eureka, Redding |
| **Work Counties** | Humboldt, Trinity, Shasta |
| **Capabilities** | Habitat restoration, wetland construction, streambank stabilization, erosion control, watershed rehabilitation, invasive species removal, native vegetation planting, ecological monitoring, environmental mitigation, post-wildfire restoration, meadow hydrology restoration |
| **Agency Experience** | U.S. Forest Service, Bureau of Land Management (BLM), California Dept of Fish and Wildlife, California Coastal Commission |
| **Contract Types** | Federal IDIQ, Task Order, Design-Build, Cooperative Agreement, Environmental Mitigation |
| **Total Contract Value** | ~$7.6M (across 4 proposals) |

### What to Verify

- Profile fields populated from the 4 proposals (not the company profile PDF)
- This is the first **non-construction** profile — tests a completely different industry vertical (Environmental Services)
- High scores expected for: environmental remediation RFPs, vegetation management, forestry, erosion control, watershed projects
- WOSB/SDB certifications test set-aside matching for woman-owned and disadvantaged business RFPs
- Lower scores expected for: roadway construction, IT services, facility renovation, urban municipal projects
- Tests how the algorithm handles niche/specialized capabilities that may not have strong synonym coverage

---

## 3. Golden Valley Infrastructure Group

**Industry:** Public Infrastructure Construction
**Size / Status:** SBA Small Business

### Test Files

| File | Purpose |
|---|---|
| [Golden Valley Infrastructure Group – Company Profile.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/golden-valley-infrastructure-group/Golden%20Valley%20Infrastructure%20Group%20%E2%80%93%20Company%20Profile.pdf) | Company profile (reference — do not upload) |
| [Proposal – Central Valley Highway Shoulder Rehabilitation.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/golden-valley-infrastructure-group/Proposal%20%E2%80%93%20Central%20Valley%20Highway%20Shoulder%20Rehabilitation.pdf) | Proposal: Caltrans highway shoulder rehab ($4.9M) |
| [Proposal – Chico Roadway Resurfacing Program.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/golden-valley-infrastructure-group/Proposal%20%E2%80%93%20Chico%20Roadway%20Resurfacing%20Program.pdf) | Proposal: City of Chico roadway resurfacing ($3.4M) |
| [Proposal – Sacramento County Bridge Approach Improvements.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/golden-valley-infrastructure-group/Proposal%20%E2%80%93%20Sacramento%20County%20Bridge%20Approach%20Improvements.pdf) | Proposal: Sacramento County bridge approach work ($3.8M) |
| [Proposal – Stockton Stormwater Pump Station Upgrade.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/golden-valley-infrastructure-group/Proposal%20%E2%80%93%20Stockton%20Stormwater%20Pump%20Station%20Upgrade.pdf) | Proposal: City of Stockton pump station modernization ($2.7M) |

### Expected Extracted Profile

After uploading the 4 proposals, the system should extract a profile approximately matching:

| Field | Expected Values |
|---|---|
| **Company Name** | Golden Valley Infrastructure Group |
| **Industry** | Construction |
| **Certifications** | SB, DBE |
| **Clearances** | OSHA-30, SAM.gov Active, CA DIR Public Works Registration |
| **NAICS Codes** | 236220, 237310, 237990 |
| **Work Cities** | Sacramento, Stockton, Modesto, Chico |
| **Work Counties** | Sacramento, San Joaquin, Stanislaus, Butte |
| **Capabilities** | Roadway paving, highway rehabilitation, concrete foundations, municipal drainage infrastructure, grading and site preparation, bridge approach construction, stormwater management, traffic control, roadway resurfacing, ADA curb ramp upgrades |
| **Agency Experience** | Caltrans, City of Stockton Public Works, Sacramento County Dept of Transportation, City of Chico Engineering Division |
| **Contract Types** | Fixed Price, Design-Bid-Build, Task Order / IDIQ, Public Works Competitive Bid |
| **Total Contract Value** | ~$14.8M (across 4 proposals) |

### What to Verify

- Profile fields populated from the 4 proposals (not the company profile PDF)
- Match score appears for construction/infrastructure RFPs on the dashboard
- High scores expected for: Caltrans highway projects, Central Valley construction, roadway resurfacing, drainage/stormwater, bridge work
- Overlap with Sierra West profile tests different geographic focus (Central Valley vs. Bay Area) — useful for verifying location proximity scoring
- Lower scores expected for: IT services, consulting, healthcare, Southern California projects

---

## 4. Peninsula Civil Constructors

**Industry:** Heavy Civil & Municipal Construction
**Size / Status:** Small Business Enterprise (SBE)

### Test Files

| File | Purpose |
|---|---|
| [Peninsula Civil Constructors – Company Profile.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/peninsula-civil-constructors/Peninsula%20Civil%20Constructors%20%E2%80%93%20Company%20Profile.pdf) | Company profile (reference — do not upload) |
| [Proposal – San Jose Neighborhood Sidewalk Accessibility Project.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/peninsula-civil-constructors/Proposal%20%E2%80%93%20San%20Jose%20Neighborhood%20Sidewalk%20Accessibility%20Project.pdf) | Proposal: San Jose ADA sidewalk reconstruction ($2.9M) |
| [Proposal – Sunnyvale Storm Drain Replacement.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/peninsula-civil-constructors/Proposal%20%E2%80%93%20Sunnyvale%20Storm%20Drain%20Replacement.pdf) | Proposal: Sunnyvale storm drain pipeline replacement ($3.6M) |
| [Proposal – Mountain View Civic Center Pavement Rehabilitation.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/peninsula-civil-constructors/Proposal%20%E2%80%93%20Mountain%20View%20Civic%20Center%20Pavement%20Rehabilitation.pdf) | Proposal: Mountain View pavement & ADA rehab ($2.8M) |
| [Proposal – Santa Clara Municipal Facility Site Improvements.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/peninsula-civil-constructors/Proposal%20%E2%80%93%20Santa%20Clara%20Municipal%20Facility%20Site%20Improvements.pdf) | Proposal: Santa Clara County facility site improvements ($2.1M) |

### Expected Extracted Profile

After uploading the 4 proposals, the system should extract a profile approximately matching:

| Field | Expected Values |
|---|---|
| **Company Name** | Peninsula Civil Constructors |
| **Industry** | Construction |
| **Certifications** | SBE, CA DIR Public Works Registration |
| **Clearances** | OSHA-30 |
| **NAICS Codes** | 237310, 237990, 238990 |
| **Work Cities** | San Jose, Sunnyvale, Mountain View, Santa Clara |
| **Work Counties** | Santa Clara, San Mateo, Alameda |
| **Capabilities** | Concrete sidewalk installation, ADA accessibility improvements, stormwater drainage systems, municipal facility renovation, grading and paving, pavement replacement, storm drain pipeline replacement, curb ramp construction |
| **Agency Experience** | City of San Jose Dept of Transportation, City of Sunnyvale Public Works, City of Mountain View Public Works, Santa Clara County Facilities Dept |
| **Contract Types** | Public Works Competitive Bid, JOC, Task Order / IDIQ |
| **Total Contract Value** | ~$11.4M (across 4 proposals) |

### What to Verify

- Profile fields populated from the 4 proposals (not the company profile PDF)
- Match score appears for construction/infrastructure RFPs on the dashboard
- High scores expected for: Bay Area municipal projects, ADA/sidewalk work, storm drain/drainage, facility site improvements
- Tests Bay Area location scoring — should score highly on Santa Clara County and Bay Area metro RFPs
- Lower scores expected for: Central Valley projects (compare with Golden Valley), IT services, highway/bridge heavy construction

---

## 5. Redwood Public Works Builders

**Industry:** Public Works & Utility Infrastructure Construction
**Size / Status:** Small Disadvantaged Business

### Test Files

| File | Purpose |
|---|---|
| [Redwood Public Works Builders – Company Profile.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/redwood-public-works/Redwood%20Public%20Works%20Builders%20%E2%80%93%20Company%20Profile.pdf) | Company profile (reference — do not upload) |
| [Proposal – Fresno County Utility Corridor Reconstruction.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/redwood-public-works/Proposal%20%E2%80%93%20Fresno%20County%20Utility%20Corridor%20Reconstruction.pdf) | Proposal: Fresno County utility corridor reconstruction ($5.1M) |
| [Proposal – Central Valley Roadway Reconstruction Program.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/redwood-public-works/Proposal%20%E2%80%93%20Central%20Valley%20Roadway%20Reconstruction%20Program.pdf) | Proposal: Regional roadway reconstruction ($6.2M) |
| [Proposal – Modesto Public Works Facility Renovation.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/redwood-public-works/Proposal%20%E2%80%93%20Modesto%20Public%20Works%20Facility%20Renovation.pdf) | Proposal: Modesto facility modernization ($3.0M) |
| [Proposal – California State Office Complex Site Improvements.pdf](https://github.com/StanfordCS194/win26-Team9/blob/documentation/docs/test-profiles/redwood-public-works/Proposal%20%E2%80%93%20California%20State%20Office%20Complex%20Site%20Improvements.pdf) | Proposal: CA DGS state office campus improvements ($4.4M) |

### Expected Extracted Profile

After uploading the 4 proposals, the system should extract a profile approximately matching:

| Field | Expected Values |
|---|---|
| **Company Name** | Redwood Public Works Builders |
| **Industry** | Construction |
| **Certifications** | DBE, MBE |
| **Clearances** | OSHA-30, SAM.gov Active |
| **NAICS Codes** | 236220, 237110, 237310 |
| **Work Cities** | Fresno, Modesto, Bakersfield |
| **Work Counties** | Fresno, Stanislaus, Kern |
| **Capabilities** | Utility infrastructure installation, roadway reconstruction, municipal facility renovation, grading, drainage improvements, ADA compliance, parking lot rehabilitation, underground utility replacement, safety barrier installation |
| **Agency Experience** | Fresno County Public Works, Regional Transportation Authority, City of Modesto Facilities Division, CA Dept of General Services |
| **Contract Types** | Design-Bid-Build, Task Order, Public Infrastructure Competitive Bid |
| **Total Contract Value** | ~$18.7M (across 4 proposals) |

### What to Verify

- Profile fields populated from the 4 proposals (not the company profile PDF)
- Match score appears for construction/infrastructure RFPs on the dashboard
- High scores expected for: Central Valley utility projects, Fresno/Stanislaus/Kern County construction, roadway reconstruction, DGS facility improvements
- Has DBE/MBE certifications — useful for testing set-aside matching on RFPs that require disadvantaged business status
- Lower scores expected for: Bay Area projects, IT services, highway-specific work (no Caltrans experience)
