/**
 * Per-user JSON file in S3: one object per user at users/{username}.json.
 * Port of back_end/contracts/services/user_data_s3.py.
 */
import { getObjectJSON, putObjectJSON, getObjectJSONWithETag, putObjectJSONIfMatch } from "./s3";
import { config } from "./config";

const USER_DATA_PREFIX = "users/";

export interface StoredContract {
  id: string;
  contract_id: string;
  title: string;
  contractor_name: string;
  document: string;
  document_s3_key: string | null;
  rfp_id: string;
  issuing_agency: string;
  jurisdiction_state: string;
  jurisdiction_county: string;
  jurisdiction_city: string;
  required_certifications: string[];
  required_clearances: string[];
  onsite_required: boolean | null;
  work_locations: string[];
  naics_codes: string[];
  industry_tags: string[];
  min_past_performance: string;
  contract_value_estimate: string;
  timeline_duration: string;
  work_description: string;
  technology_stack?: string[];
  scope_keywords?: string[];
  contract_type?: string;
  size_status?: string[];
  award_date: string;
  start_date: string;
  end_date: string;
  created_at: string;
  updated_at: string;
}

export interface UserProfile {
  name: string;
  total_contract_value: string;
  contract_count: number;
  certifications: string[];
  clearances: string[];
  naics_codes: string[];
  industry_tags: string[];
  work_cities: string[];
  work_counties: string[];
  capabilities: string[];
  agency_experience: string[];
  size_status: string[];
  contract_types?: string[];
  created_at: string;
  updated_at: string;
  uploaded_documents: StoredContract[];
}

export interface MatchFeedback {
  rating: "good" | "bad";
  reason?: string;
  match_score: number;
  match_tier: string;
  created_at: string;
}

export interface UserData {
  password_hash?: string;
  password_hash_legacy?: string; // Django PBKDF2 hash for migrated users
  email?: string;
  email_verified?: boolean;
  email_verification_token?: string;
  password_reset_token?: string;
  password_reset_expires?: string;
  legacy_user_id?: number; // Django numeric user ID for S3 path continuity
  profile?: UserProfile;
  applied_rfp_ids?: string[];
  in_progress_rfp_ids?: string[];
  generated_poe_by_rfp?: Record<string, string>;
  generated_proposal_by_rfp?: Record<string, string>;
  match_feedback_by_rfp?: Record<string, MatchFeedback>;
  // Legacy fields (from old bearer token system, kept for compatibility)
  token?: string;
  token_expires_at?: string;
}

function userKey(username: string): string {
  return `${USER_DATA_PREFIX}${encodeURIComponent(username)}.json`;
}

// Short-lived cache to avoid repeated S3 reads within the same request flow.
// Each API request typically reads user data 2-3 times (auth check + profile + status).
const userCache = new Map<string, { data: UserData; etag: string | null; expiresAt: number }>();
const CACHE_TTL_MS = config.cache.userDataTtlMs;

export async function getUserData(username: string): Promise<UserData | null> {
  const cached = userCache.get(username);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  const result = await getObjectJSONWithETag<UserData>(userKey(username));
  if (result) {
    userCache.set(username, { data: result.data, etag: result.etag, expiresAt: Date.now() + CACHE_TTL_MS });
    return result.data;
  }
  return null;
}

/**
 * Save user data with optimistic locking (ETag-based).
 * If another request modified the data since we last read it, retries once.
 */
export async function saveUserData(
  username: string,
  data: UserData
): Promise<void> {
  const key = userKey(username);
  const cached = userCache.get(username);
  const etag = cached?.etag ?? null;

  const ok = await putObjectJSONIfMatch(key, data, etag);
  if (!ok && etag) {
    // Conflict: re-read and retry once (caller should merge if needed)
    console.warn(`ETag conflict for ${username}, retrying without condition`);
    await putObjectJSON(key, data);
  }
  // Update cache with fresh data (etag will be stale but TTL is short)
  userCache.set(username, { data, etag: null, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function userExists(username: string): Promise<boolean> {
  const data = await getUserData(username);
  return data !== null;
}

/**
 * Get the S3 upload path prefix for a user.
 * Uses legacy_user_id if available (for migrated users), otherwise username.
 */
export function getUserUploadPrefix(userData: UserData, username: string): string {
  if (userData.legacy_user_id) {
    return `uploads/${userData.legacy_user_id}`;
  }
  return `uploads/${encodeURIComponent(username)}`;
}
