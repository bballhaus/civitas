/**
 * User profile storage and aggregation.
 * Port of back_end/contracts/services/profile_storage.py.
 */
import { getUserData, saveUserData, type UserProfile, type UserData } from "./user-data";
import { listContracts } from "./contract-storage";

const PROFILE_ATTRS = [
  "name",
  "total_contract_value",
  "contract_count",
  "certifications",
  "clearances",
  "naics_codes",
  "industry_tags",
  "work_cities",
  "work_counties",
  "capabilities",
  "agency_experience",
  "size_status",
  "contract_types",
  "created_at",
  "updated_at",
  "uploaded_documents",
] as const;

function defaultProfile(): UserProfile {
  const now = new Date().toISOString();
  return {
    name: "",
    total_contract_value: "0",
    contract_count: 0,
    certifications: [],
    clearances: [],
    naics_codes: [],
    industry_tags: [],
    work_cities: [],
    work_counties: [],
    capabilities: [],
    agency_experience: [],
    size_status: [],
    contract_types: [],
    created_at: now,
    updated_at: now,
    uploaded_documents: [],
  };
}

function jsonToProfile(raw: Record<string, unknown>): UserProfile {
  if (!raw) return defaultProfile();
  let total = raw.total_contract_value;
  if (total != null && typeof total !== "string") total = String(total);

  return {
    name: (raw.name as string) || "",
    total_contract_value: (total as string) ?? "0",
    contract_count: Number(raw.contract_count || 0),
    certifications: (raw.certifications as string[]) || [],
    clearances: (raw.clearances as string[]) || [],
    naics_codes: (raw.naics_codes as string[]) || [],
    industry_tags: (raw.industry_tags as string[]) || [],
    work_cities: (raw.work_cities as string[]) || [],
    work_counties: (raw.work_counties as string[]) || [],
    capabilities: (raw.capabilities as string[]) || [],
    agency_experience: (raw.agency_experience as string[]) || [],
    size_status: (raw.size_status as string[]) || [],
    contract_types: (raw.contract_types as string[]) || [],
    created_at: (raw.created_at as string) || "",
    updated_at: (raw.updated_at as string) || "",
    uploaded_documents: (raw.uploaded_documents as any[]) || [],
  };
}

function profileToJson(profile: UserProfile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PROFILE_ATTRS) {
    let v = (profile as unknown as Record<string, unknown>)[k];
    if (v == null && k === "total_contract_value") v = "0";
    if (v == null && k === "contract_count") v = 0;
    if (v == null && k === "uploaded_documents") v = [];
    if (k === "total_contract_value" && typeof v === "number") v = String(v);
    if (v != null) out[k] = v;
  }
  return out;
}

// ── Public API ──

export async function getProfile(username: string): Promise<UserProfile | null> {
  const data = await getUserData(username);
  if (!data?.profile) return null;
  return jsonToProfile(data.profile as unknown as Record<string, unknown>);
}

export async function saveProfile(
  username: string,
  profile: UserProfile
): Promise<void> {
  const data = (await getUserData(username)) || ({} as UserData);
  data.profile = profileToJson(profile) as unknown as UserProfile;
  await saveUserData(username, data);
}

export async function getOrCreateProfile(username: string): Promise<UserProfile> {
  try {
    const existing = await getProfile(username);
    if (existing) return existing;

    const profile = defaultProfile();
    const data = (await getUserData(username)) || ({} as UserData);
    data.profile = profileToJson(profile) as unknown as UserProfile;
    if (!data.applied_rfp_ids) data.applied_rfp_ids = [];
    if (!data.in_progress_rfp_ids) data.in_progress_rfp_ids = [];
    await saveUserData(username, data);
    return profile;
  } catch (err) {
    console.warn(`getOrCreateProfile failed for username=${username}:`, err);
    return defaultProfile();
  }
}

// Keywords that indicate size/status designations (not certifications)
const SIZE_STATUS_KEYWORDS = [
  "small business",
  "large business",
  "sdb",
  "wosb",
  "edwosb",
  "hubzone",
  "8(a)",
  "8a",
  "sdvosb",
  "vosb",
  "dbe",
  "mbe",
  "wbe",
  "minority-owned",
  "woman-owned",
  "women-owned",
  "veteran-owned",
  "service-disabled",
  "disadvantaged business",
  "sba ",
  "small disadvantaged",
];

/**
 * Recompute profile from all user contracts and save to S3.
 * Port of back_end/contracts/services/profile_storage.py:refresh_profile_from_contracts
 */
export async function refreshProfileFromContracts(
  username: string
): Promise<UserProfile> {
  const contractList = await listContracts(username);

  const certs = new Set<string>();
  const clearancesSet = new Set<string>();
  const naics = new Set<string>();
  const tags = new Set<string>();
  const cities = new Set<string>();
  const counties = new Set<string>();
  const capabilitiesSet = new Set<string>();
  const agencies = new Set<string>();
  const contractTypes = new Set<string>();
  const sizeStatuses = new Set<string>();
  const contractorNames = new Set<string>();
  let totalVal = 0;

  for (const c of contractList) {
    const cn = c.contractor_name;
    if (cn?.trim()) contractorNames.add(cn.trim());

    // Reclassify size/status designations from certifications
    for (const certItem of c.required_certifications || []) {
      if (!certItem?.trim()) continue;
      const certLower = certItem.toLowerCase().trim();
      if (SIZE_STATUS_KEYWORDS.some((kw) => certLower.includes(kw))) {
        sizeStatuses.add(certItem.trim());
      } else {
        certs.add(certItem.trim());
      }
    }

    for (const cl of c.required_clearances || []) {
      if (cl?.trim()) clearancesSet.add(cl.trim());
    }
    for (const n of c.naics_codes || []) {
      if (n?.trim()) naics.add(n.trim());
    }
    for (const t of c.industry_tags || []) {
      if (t?.trim()) tags.add(t.trim());
    }
    if (c.jurisdiction_city) cities.add(c.jurisdiction_city);
    if (c.jurisdiction_county) counties.add(c.jurisdiction_county);
    for (const wl of c.work_locations || []) {
      if (wl?.trim()) cities.add(wl.trim());
    }
    if (c.issuing_agency) agencies.add(c.issuing_agency);
    if (c.work_description?.trim()) capabilitiesSet.add(c.work_description.trim());

    // Technology stack
    for (const t of c.technology_stack || []) {
      if (t?.trim()) capabilitiesSet.add(t.trim());
    }
    // Scope keywords
    for (const kw of c.scope_keywords || []) {
      if (kw?.trim()) capabilitiesSet.add(kw.trim());
    }
    // Contract types
    const ct: unknown = c.contract_type;
    if (Array.isArray(ct)) {
      for (const t of ct) {
        if (typeof t === "string" && t.trim()) contractTypes.add(t.trim());
      }
    } else if (typeof ct === "string" && ct.trim()) {
      contractTypes.add(ct.trim());
    }

    // Size/status from dedicated field
    const ss: unknown = c.size_status || [];
    if (Array.isArray(ss)) {
      for (const s of ss) {
        if (typeof s === "string" && s.trim()) sizeStatuses.add(s.trim());
      }
    } else if (typeof ss === "string" && ss.trim()) {
      sizeStatuses.add(ss.trim());
    }

    // Contract value
    try {
      const valStr = (c.contract_value_estimate || "0")
        .replace(/,/g, "")
        .replace(/\$/g, "");
      totalVal += parseFloat(valStr) || 0;
    } catch {
      // skip invalid values
    }
  }

  const now = new Date().toISOString();
  const existing = (await getProfile(username)) || defaultProfile();

  // Keep full contract list in uploaded_documents
  const uploadedDocuments = contractList.map((c) => ({ ...c }));

  // Auto-set name from contractor names if empty
  if (!existing.name && contractorNames.size > 0) {
    existing.name = [...contractorNames].sort()[0];
  }

  const updated: UserProfile = {
    ...existing,
    certifications: [...certs],
    clearances: [...clearancesSet],
    naics_codes: [...naics],
    industry_tags: [...tags],
    work_cities: [...cities],
    work_counties: [...counties],
    capabilities: [...capabilitiesSet],
    agency_experience: [...agencies],
    size_status: [...sizeStatuses],
    contract_types: [...contractTypes],
    contract_count: contractList.length,
    total_contract_value: String(totalVal),
    updated_at: now,
    uploaded_documents: uploadedDocuments,
  };

  await saveProfile(username, updated);
  return updated;
}
