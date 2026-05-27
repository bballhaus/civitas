/**
 * Admin gate for the dev /admin/* surfaces (KPI dashboard, event drill-down).
 *
 * Allowlist is intentionally hardcoded — pre-launch we don't need an
 * `is_admin` column or env-var indirection. Add to ADMIN_EMAILS to grant
 * access. Emails are matched lowercased; lookup goes through the JWT-derived
 * username → Postgres email (username and email are distinct fields).
 */
import { getAuthenticatedUser } from "./auth";
import { getUserByUsername } from "@/db/queries/users";

const ADMIN_EMAILS: ReadonlySet<string> = new Set([
  "brooke@civitas-ai.net",
]);

export interface AdminUser {
  userId: string;
  username: string;
  email: string;
}

/**
 * Verify the request is authenticated AND the authenticated user's email is
 * on the admin allowlist. Returns null when either check fails — callers
 * should respond with 401/403 without leaking which.
 */
export async function requireAdmin(request: Request): Promise<AdminUser | null> {
  const auth = await getAuthenticatedUser(request);
  if (!auth) return null;
  const user = await getUserByUsername(auth.username);
  if (!user?.email) return null;
  if (!ADMIN_EMAILS.has(user.email.toLowerCase())) return null;
  return { userId: auth.userId, username: auth.username, email: user.email };
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.toLowerCase());
}
