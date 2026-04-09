/**
 * Per-user JSON file in S3: one object per user at users/{username}.json.
 * Port of back_end/contracts/services/user_data_s3.py.
 */
import { getObjectJSON, putObjectJSON } from "./s3";

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

export interface UserData {
  password_hash?: string;
  password_hash_legacy?: string; // Django PBKDF2 hash for migrated users
  email?: string;
  legacy_user_id?: number; // Django numeric user ID for S3 path continuity
  profile?: UserProfile;
  applied_rfp_ids?: string[];
  in_progress_rfp_ids?: string[];
  generated_poe_by_rfp?: Record<string, string>;
  generated_proposal_by_rfp?: Record<string, string>;
  // Legacy fields (from old bearer token system, kept for compatibility)
  token?: string;
  token_expires_at?: string;
}

function userKey(username: string): string {
  return `${USER_DATA_PREFIX}${encodeURIComponent(username)}.json`;
}

export async function getUserData(username: string): Promise<UserData | null> {
  return getObjectJSON<UserData>(userKey(username));
}

export async function saveUserData(
  username: string,
  data: UserData
): Promise<void> {
  await putObjectJSON(userKey(username), data);
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
