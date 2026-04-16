/**
 * Structured security event logging.
 * Outputs JSON to stdout — captured by Vercel/CloudWatch.
 */

export type SecurityEventType =
  | "login_success"
  | "login_failure"
  | "signup"
  | "password_change"
  | "password_reset_request"
  | "password_reset_complete"
  | "email_verified";

export function logSecurityEvent(event: {
  type: SecurityEventType;
  username?: string;
  ip?: string;
  details?: string;
}): void {
  console.log(
    JSON.stringify({
      level: "security",
      timestamp: new Date().toISOString(),
      ...event,
    })
  );
}
