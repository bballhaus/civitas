/**
 * Lightweight email uniqueness index stored in S3.
 * Maps email addresses to usernames for uniqueness checks during signup.
 */
import { getObjectJSON, putObjectJSON } from "./s3";

const INDEX_KEY = "system/email-index.json";

type EmailIndex = Record<string, string>; // { "email@example.com": "username" }

let cachedIndex: EmailIndex | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

async function loadIndex(): Promise<EmailIndex> {
  const now = Date.now();
  if (cachedIndex && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedIndex;
  }
  cachedIndex = (await getObjectJSON<EmailIndex>(INDEX_KEY)) ?? {};
  cacheTimestamp = now;
  return cachedIndex;
}

/**
 * Check if an email is already registered. Returns the owning username or null.
 */
export async function checkEmailUniqueness(email: string): Promise<string | null> {
  const index = await loadIndex();
  return index[email.toLowerCase()] ?? null;
}

/**
 * Register a new email → username mapping.
 */
export async function registerEmail(email: string, username: string): Promise<void> {
  const index = await loadIndex();
  index[email.toLowerCase()] = username;
  await putObjectJSON(INDEX_KEY, index);
  cachedIndex = index;
  cacheTimestamp = Date.now();
}
