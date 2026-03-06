const PRODUCTION_API = "https://civitas-server.onrender.com/api";
const DEV_API = "http://localhost:8000/api";

export function getApiBase(): string {
  const isDev = process.env.NODE_ENV === "development";
  const base =
    process.env.NEXT_PUBLIC_API_BASE ||
    (typeof window === "undefined" ? process.env.API_BASE : undefined) ||
    (isDev ? DEV_API : PRODUCTION_API) ||
    PRODUCTION_API;
  const url = (base || PRODUCTION_API).replace(/\/$/, "");
  return url || PRODUCTION_API;
}
const API_BASE = getApiBase();

async function getCsrfToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/csrf/`, { method: "GET", credentials: "include" });
  if (!res.ok) throw new Error("Failed to get CSRF token");
  const data = await res.json();
  return data.csrfToken;
}

export interface CurrentUser {
  user_id: number;
  username: string;
  email?: string;
  profile?: AuthMeProfile;
  /** RFP ids the user has marked as "I've applied" (stored in user data). */
  applied_rfp_ids?: string[];
  /** RFP ids the user has generated a Plan of Action for (in progress). */
  in_progress_rfp_ids?: string[];
}

/** Profile shape returned by GET /api/auth/me/ (from AWS). */
export interface AuthMeProfile {
  id: number;
  name: string;
  contract_count: number;
  total_past_contract_value: number | string;
  certifications: string[];
  clearances: string[];
  naics_codes: string[];
  industry_tags: string[];
  work_cities: string[];
  work_counties: string[];
  capabilities: string[];
  agency_experience: string[];
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

export function mapBackendProfileToCompanyProfile(
  p: AuthMeProfile | null | undefined
): CompanyProfileFromApi | null {
  if (!p) return null;
  const total =
    typeof p.total_past_contract_value === "number"
      ? String(p.total_past_contract_value)
      : String(p.total_past_contract_value ?? "0");
  return {
    companyName: p.name ?? "",
    industry: Array.isArray(p.industry_tags) ? p.industry_tags : [],
    sizeStatus: [],
    certifications: Array.isArray(p.certifications) ? p.certifications : [],
    clearances: Array.isArray(p.clearances) ? p.clearances : [],
    naicsCodes: Array.isArray(p.naics_codes) ? p.naics_codes : [],
    workCities: Array.isArray(p.work_cities) ? p.work_cities : [],
    workCounties: Array.isArray(p.work_counties) ? p.work_counties : [],
    capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
    agencyExperience: Array.isArray(p.agency_experience) ? p.agency_experience : [],
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
const CACHED_PROFILE_KEY = "civitas_cached_profile";
const AUTH_TOKEN_KEY = "civitas_auth_token";

const LOG_PREFIX = "[Civitas]";

/** Auth token (Bearer) stored in AWS DynamoDB; avoids session/cookie cross-origin issues. */
export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    console.log(`${LOG_PREFIX} Auth token stored (Bearer, from AWS DynamoDB)`);
  } catch {
    // ignore
  }
}

export function clearAuthToken(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    console.log(`${LOG_PREFIX} Auth token cleared`);
  } catch {
    // ignore
  }
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

/** Read cached user from localStorage (for instant dashboard load when profile + events are also cached). */
export function getCachedUser(): { user_id: number; username: string; email?: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { user_id?: number; username?: string; email?: string };
    if (typeof data?.user_id === "number" && typeof data?.username === "string") {
      return { user_id: data.user_id, username: data.username, email: data.email };
    }
    return null;
  } catch {
    return null;
  }
}

/** Store user in localStorage (used only for non–profile flows if needed). */
export function setCachedUser(user: { user_id: number; username: string; email?: string }): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    console.log(`${LOG_PREFIX} Cache set: user_id=${user.user_id} username=${user.username}`);
  } catch {
    // ignore
  }
}

/** Clear cached user so only backend/AWS is trusted. */
export function clearCachedUser(): void {
  if (typeof window === "undefined") return;
  try {
    const had = localStorage.getItem(CACHED_USER_KEY);
    localStorage.removeItem(CACHED_USER_KEY);
    clearProfileCache();
    console.log(`${LOG_PREFIX} Cache cleared: cached user removed${had ? " (had previous user)" : ""} — only backend/AWS trusted`);
  } catch {
    // ignore
  }
}

/** Profile cache: in-memory + localStorage for instant loads across refreshes. */
let profileCache: { userId: number; profile: CompanyProfileFromApi } | null = null;

export function getCachedProfile(userId: number): CompanyProfileFromApi | null {
  if (profileCache && profileCache.userId === userId) return profileCache.profile;
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHED_PROFILE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { userId?: number; profile?: CompanyProfileFromApi };
    if (data?.userId === userId && data?.profile) {
      profileCache = { userId, profile: data.profile };
      return data.profile;
    }
  } catch {
    // ignore
  }
  return null;
}

export function setCachedProfile(userId: number, profile: CompanyProfileFromApi): void {
  profileCache = { userId, profile };
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHED_PROFILE_KEY, JSON.stringify({ userId, profile }));
  } catch {
    // ignore
  }
}

export function clearProfileCache(): void {
  profileCache = null;
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CACHED_PROFILE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Fetch current user (and optionally profile) from backend.
 * When includeProfile is false (default), only user_id/username are returned — no S3/AWS call.
 * When includeProfile is true, profile is loaded from S3 (slower). Use for dashboard matching, etc.
 */
export async function getCurrentUser(includeProfile = false): Promise<CurrentUser | null> {
  const url = includeProfile ? `${API_BASE}/auth/me/?include_profile=1` : `${API_BASE}/auth/me/`;
  console.log(`${LOG_PREFIX} Fetching current user from backend (GET auth/me, includeProfile=${includeProfile})...`);
  const res = await fetch(url, {
    credentials: "include",
    headers: { ...authHeaders() },
  });
  if (!res.ok) {
    console.log(`${LOG_PREFIX} Backend auth/me returned ${res.status} — not logged in or token/session invalid`);
    return null;
  }
  const data = await res.json();
  console.log(`${LOG_PREFIX} Backend auth/me OK: user_id=${data?.user_id} username=${data?.username}${includeProfile ? " (profile from AWS)" : ""}`);
  return data;
}

/**
 * Fetch profile from backend (S3). Use when user wants to view/edit profile so we only hit AWS on demand.
 */
export async function getProfileFromBackend(): Promise<AuthMeProfile> {
  const res = await fetch(`${API_BASE}/profile/`, {
    credentials: "include",
    headers: { ...authHeaders() },
  });
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
}

/**
 * Mark an RFP as applied, remove from applied, and/or mark in progress. Stored in user data in S3.
 * Requires auth (Bearer token or session + CSRF).
 */
export async function updateUserRfpStatus(payload: {
  mark_applied?: string;
  remove_applied?: string;
  mark_in_progress?: string;
}): Promise<UserRfpStatusResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders() };
  // Always send CSRF when using credentials so session auth works (Bearer may be expired)
  headers["X-CSRFToken"] = await getCsrfToken();
  const res = await fetch(`${API_BASE}/user/rfp-status/`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; detail?: string };
    const msg =
      res.status === 401
        ? "Please log in to save your RFP status."
        : err?.error || err?.detail || (typeof err?.detail === "string" ? err.detail : null) || `Failed to update (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

/** Payload for PATCH /api/profile/ (snake_case, writable fields only). */
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

/**
 * Save profile to backend. Persists to S3 users/{username}.json. Requires session or Bearer token.
 */
export async function saveProfileToBackend(payload: ProfilePatchPayload): Promise<AuthMeProfile> {
  console.log(`${LOG_PREFIX} Saving profile to backend (PATCH /api/profile/) — will update user JSON in S3`);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders() };
  if (!getAuthToken()) headers["X-CSRFToken"] = await getCsrfToken();
  const res = await fetch(`${API_BASE}/profile/`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || err.error || "Failed to save profile");
  }
  const data = await res.json();
  console.log(`${LOG_PREFIX} Profile saved to backend; user JSON updated in S3`);
  return data;
}

/**
 * Upload a single document as a contract. File is stored in S3 (uploads/{user_id}/{contract_id}/)
 * and the user's profile JSON is updated with uploaded_documents. Requires auth.
 */
export async function uploadContractDocument(
  file: File,
  title?: string
): Promise<{ id: string; title: string; document: string }> {
  const formData = new FormData();
  formData.append("document", file);
  formData.append("title", title ?? file.name ?? "document");

  const headers: Record<string, string> = { ...authHeaders() };
  if (!getAuthToken()) {
    headers["X-CSRFToken"] = await getCsrfToken();
  }
  // Do not set Content-Type; browser sets multipart/form-data with boundary

  const res = await fetch(`${API_BASE}/contracts/`, {
    method: "POST",
    headers,
    credentials: "include",
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detailStr = err.detail ? (typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail)) : "";
    const docStr = err.document != null
      ? (Array.isArray(err.document) ? err.document.join(", ") : String(err.document))
      : "";
    const msg =
      err.error || detailStr || docStr || `Upload failed (${res.status})`;
    throw new Error(msg.trim() || "Failed to upload document");
  }
  const data = await res.json();
  return { id: data.id, title: data.title ?? title ?? file.name, document: data.document ?? "" };
}

/**
 * Delete a contract document by id. Removes it from S3 and from the user's profile JSON. Requires auth.
 */
export async function deleteContractDocument(contractId: string): Promise<void> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (!getAuthToken()) {
    headers["X-CSRFToken"] = await getCsrfToken();
  }
  const res = await fetch(`${API_BASE}/contracts/${encodeURIComponent(contractId)}/`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.detail ?? err.error ?? `Delete failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
}

/**
 * Update email only. Username cannot be changed.
 */
export async function updateUser(data: { email?: string }): Promise<CurrentUser> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders() };
  if (!getAuthToken()) headers["X-CSRFToken"] = await getCsrfToken();
  const res = await fetch(`${API_BASE}/auth/me/`, {
    method: "PATCH",
    headers,
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Update failed");
  }
  return res.json();
}

/**
 * Change password.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders() };
  if (!getAuthToken()) headers["X-CSRFToken"] = await getCsrfToken();
  const res = await fetch(`${API_BASE}/auth/change-password/`, {
    method: "POST",
    headers,
    credentials: "include",
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

/**
 * Log out: send Bearer token so backend can delete it from AWS; then clear local token and redirect.
 */
export async function logout(router: { push: (path: string) => void }) {
  try {
    const headers: Record<string, string> = { ...authHeaders() };
    try {
      headers["X-CSRFToken"] = await getCsrfToken();
    } catch {
      // CSRF optional when using Bearer
    }
    await fetch(`${API_BASE}/auth/logout/`, {
      method: "POST",
      headers,
      credentials: "include",
    });
  } catch {
    // Still redirect so user can try again
  }
  console.log(`${LOG_PREFIX} Logout: clearing auth token and cached user, redirecting to login`);
  clearAuthToken();
  clearCachedUser();
  router.push("/login");
}
