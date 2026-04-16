/**
 * Frontend API client.
 * Auth is handled via HttpOnly cookies (set by server).
 * All API calls go to same-origin /api/... routes — cookies are sent automatically.
 */

import type { MatchFeedback } from "./user-data";

export interface CurrentUser {
  user_id?: number;
  username: string;
  email?: string;
  profile?: AuthMeProfile;
  applied_rfp_ids?: string[];
  in_progress_rfp_ids?: string[];
  match_feedback_by_rfp?: Record<string, MatchFeedback>;
}

/** Profile shape returned by GET /api/auth/me/ and GET /api/profile/. */
export interface AuthMeProfile {
  name: string;
  contract_count: number;
  total_contract_value?: number | string;
  total_past_contract_value?: number | string;
  certifications: string[];
  clearances: string[];
  naics_codes: string[];
  industry_tags: string[];
  work_cities: string[];
  work_counties: string[];
  capabilities: string[];
  agency_experience: string[];
  size_status?: string[];
  created_at?: string;
  updated_at?: string;
  uploaded_documents?: Array<{ id: string; title: string; document: string; created_at: string }>;
}

/** Frontend profile shape (dashboard + profile page). */
export interface CompanyProfileFromApi {
  companyName: string;
  industry: string[];
  sizeStatus: string[];
  certifications: string[];
  clearances: string[];
  naicsCodes: string[];
  workCities: string[];
  workCounties: string[];
  capabilities: string[];
  agencyExperience: string[];
  contractTypes: string[];
  contractCount: number;
  totalPastContractValue: string;
  pastPerformance: string;
  strategicGoals: string;
  uploadedFiles?: Array<{
    name: string;
    type: string;
    size: number;
    uploadedAt: string;
    parsed?: boolean;
    uploadedToBackend?: boolean;
    contractId?: string;
  }>;
}

/**
 * Clean a string array from backend data:
 * - Split comma-separated entries into individual items
 * - Remove "null", "undefined", empty strings
 * - Trim whitespace
 * - Title-case each item (e.g. "sacramento" → "Sacramento", "san jose" → "San Jose")
 * - Deduplicate (case-insensitive)
 */
function cleanStringArray(arr: unknown, opts?: { titleCase?: boolean }): string[] {
  if (!Array.isArray(arr)) return [];
  const doTitleCase = opts?.titleCase ?? false;
  const items: string[] = [];
  for (const entry of arr) {
    if (entry == null) continue;
    const str = String(entry);
    for (const part of str.split(",")) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "undefined") continue;
      items.push(trimmed);
    }
  }
  const seen = new Map<string, string>();
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, doTitleCase ? titleCase(item) : item);
    }
  }
  return [...seen.values()];
}

const TITLE_CASE_LOWER = new Set(["and", "or", "of", "the", "in", "for", "a", "an", "to", "at", "by", "on"]);
function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i > 0 && TITLE_CASE_LOWER.has(lower)) return lower;
      if (word.length <= 4 && word === word.toUpperCase() && /^[A-Z]/.test(word)) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function mapBackendProfileToCompanyProfile(
  p: AuthMeProfile | null | undefined
): CompanyProfileFromApi | null {
  if (!p) return null;
  const totalRaw = p.total_past_contract_value ?? p.total_contract_value ?? "0";
  const total = typeof totalRaw === "number" ? String(totalRaw) : String(totalRaw);
  return {
    companyName: titleCase((p.name ?? "").trim()),
    industry: cleanStringArray(p.industry_tags, { titleCase: true }),
    sizeStatus: cleanStringArray(p.size_status),
    certifications: cleanStringArray(p.certifications),
    clearances: cleanStringArray(p.clearances),
    naicsCodes: cleanStringArray(p.naics_codes),
    workCities: cleanStringArray(p.work_cities, { titleCase: true }),
    workCounties: cleanStringArray(p.work_counties, { titleCase: true }),
    capabilities: cleanStringArray(p.capabilities, { titleCase: true }),
    agencyExperience: cleanStringArray(p.agency_experience, { titleCase: true }),
    contractTypes: [],
    contractCount: typeof p.contract_count === "number" ? p.contract_count : 0,
    totalPastContractValue: total,
    pastPerformance: "",
    strategicGoals: "",
    uploadedFiles: Array.isArray(p.uploaded_documents)
      ? p.uploaded_documents.map((d) => ({
          name: d.title || "document",
          type: "application/octet-stream",
          size: 0,
          uploadedAt: d.created_at || "",
          parsed: true,
          uploadedToBackend: true,
          contractId: d.id ?? undefined,
        }))
      : [],
  };
}

export function getEmptyCompanyProfile(): CompanyProfileFromApi {
  return {
    companyName: "",
    industry: [],
    sizeStatus: [],
    certifications: [],
    clearances: [],
    naicsCodes: [],
    workCities: [],
    workCounties: [],
    capabilities: [],
    agencyExperience: [],
    contractTypes: [],
    contractCount: 0,
    totalPastContractValue: "",
    pastPerformance: "",
    strategicGoals: "",
    uploadedFiles: [],
  };
}

const CACHED_USER_KEY = "civitas_current_user";

const LOG_PREFIX = "[Civitas]";

// Auth tokens are now stored in HttpOnly cookies (set by server).
// These legacy functions are kept for backward compatibility but are no-ops.
/** @deprecated Auth is now cookie-based. This always returns null. */
export function getAuthToken(): string | null {
  return null;
}
/** @deprecated Auth is now cookie-based. This is a no-op. */
export function setAuthToken(_token: string): void {}
/** @deprecated Auth is now cookie-based. This is a no-op. */
export function clearAuthToken(): void {}

export function getCachedUser(): { user_id: number; username: string; email?: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { user_id?: number; username?: string; email?: string };
    if (typeof data?.username === "string") {
      return { user_id: data.user_id ?? 0, username: data.username, email: data.email };
    }
    return null;
  } catch {
    return null;
  }
}

export function setCachedUser(user: { user_id?: number; username: string; email?: string }): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    console.log(`${LOG_PREFIX} Cache set: username=${user.username}`);
  } catch {
    // ignore
  }
}

export const RFP_STORAGE_KEYS = [
  "civitas_saved_rfps",
  "civitas_not_interested_rfps",
  "civitas_expressed_interest_rfps",
  "civitas_preload_rfp",
] as const;

export function clearUserSpecificStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of RFP_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
    localStorage.removeItem("companyProfile");
    localStorage.removeItem("extractedProfileData");
    localStorage.removeItem("uploadedFiles");
    console.log(`${LOG_PREFIX} User-specific storage cleared`);
  } catch {
    // ignore
  }
}

export function clearCachedUser(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CACHED_USER_KEY);
    clearProfileCache();
    clearUserSpecificStorage();
    console.log(`${LOG_PREFIX} Cache cleared`);
  } catch {
    // ignore
  }
}

let profileCache: { username: string; profile: CompanyProfileFromApi } | null = null;

export function getCachedProfile(userId?: number): CompanyProfileFromApi | null {
  if (profileCache) return profileCache.profile;
  return null;
}

export function setCachedProfile(userId: number | undefined, profile: CompanyProfileFromApi): void {
  const cached = getCachedUser();
  profileCache = { username: cached?.username || "", profile };
}

export function clearProfileCache(): void {
  profileCache = null;
}

/**
 * Fetch current user (and optionally profile) from backend.
 */
export async function getCurrentUser(includeProfile = false): Promise<CurrentUser | null> {
  const url = includeProfile ? "/api/auth/me/?include_profile=1" : "/api/auth/me/";
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Fetch profile from backend (S3).
 */
export async function getProfileFromBackend(): Promise<AuthMeProfile> {
  const res = await fetch("/api/profile/");
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || err.error || "Failed to load profile");
  }
  return res.json();
}

/** Response from PATCH /api/user/rfp-status/ */
export interface UserRfpStatusResponse {
  applied_rfp_ids: string[];
  in_progress_rfp_ids: string[];
  match_feedback_by_rfp?: Record<string, MatchFeedback>;
}

export async function getGeneratedPoe(rfpId: string): Promise<string | null> {
  const res = await fetch(
    `/api/user/generated-poe/?rfp_id=${encodeURIComponent(rfpId)}`
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { plan_of_execution?: string | null };
  return data.plan_of_execution ?? null;
}

export async function getGeneratedProposal(rfpId: string): Promise<string | null> {
  const res = await fetch(
    `/api/user/generated-proposal/?rfp_id=${encodeURIComponent(rfpId)}`
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { proposal?: string | null };
  return data.proposal ?? null;
}

export async function updateUserRfpStatus(payload: {
  mark_applied?: string;
  remove_applied?: string;
  mark_in_progress?: string;
  remove_in_progress?: string;
  save_generated_poe?: { rfp_id: string; content: string };
  save_generated_proposal?: { rfp_id: string; content: string };
  submit_match_feedback?: { rfp_id: string; rating: "good" | "bad"; reason?: string; match_score: number; match_tier: string };
  remove_match_feedback?: string;
}): Promise<UserRfpStatusResponse> {
  const res = await fetch("/api/user/rfp-status/", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; detail?: string };
    const msg =
      res.status === 401
        ? "Please log in to save your RFP status."
        : err?.error || err?.detail || `Failed to update (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

/** Payload for PATCH /api/profile/ */
export interface ProfilePatchPayload {
  name?: string;
  contract_count?: number;
  certifications?: string[];
  clearances?: string[];
  naics_codes?: string[];
  industry_tags?: string[];
  work_cities?: string[];
  work_counties?: string[];
  capabilities?: string[];
  agency_experience?: string[];
}

export async function saveProfileToBackend(payload: ProfilePatchPayload): Promise<AuthMeProfile> {
  const res = await fetch("/api/profile/", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.detail || err.error || "Failed to save profile";
    if (res.status === 401) {
      throw new Error("Your session may have expired. Please log out and log back in, then try saving again.");
    }
    throw new Error(msg);
  }
  return res.json();
}

export async function listContracts(): Promise<Array<{ id: string; title: string; document: string }>> {
  const res = await fetch("/api/contracts/");
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function uploadContractDocument(
  file: File,
  title?: string
): Promise<{ id: string; title: string; document: string }> {
  const formData = new FormData();
  formData.append("document", file);
  formData.append("title", title ?? file.name ?? "document");

  const res = await fetch("/api/contracts/", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detailStr = err.detail ? (typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail)) : "";
    const docStr = err.document != null
      ? (Array.isArray(err.document) ? err.document.join(", ") : String(err.document))
      : "";
    const msg = err.error || detailStr || docStr || `Upload failed (${res.status})`;
    throw new Error(msg.trim() || "Failed to upload document");
  }
  const data = await res.json();
  return { id: data.id, title: data.title ?? title ?? file.name, document: data.document ?? "" };
}

export async function deleteContractDocument(contractId: string): Promise<void> {
  const res = await fetch(`/api/contracts/${encodeURIComponent(contractId)}/`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    const msg = err.detail ?? err.error ?? `Delete failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
}

export async function updateUser(data: { email?: string }): Promise<CurrentUser> {
  const res = await fetch("/api/auth/me/", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Update failed");
  }
  return res.json();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch("/api/auth/change-password/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Password change failed");
  }
}

export async function logout(router: { push: (path: string) => void }) {
  try {
    await fetch("/api/auth/logout/", {
      method: "POST",
    });
  } catch {
    // Still redirect
  }
  // Cookie is cleared server-side; clear local caches
  clearCachedUser();
  router.push("/login");
}

// Keep getApiBase export for any code that still imports it (will return empty string)
export function getApiBase(): string {
  return "";
}
