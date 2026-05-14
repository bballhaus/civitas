/**
 * KPI event taxonomy: event-type union, allowlists, and the per-event mapping
 * to the counter / funnel field it should update on the per-user summary.
 *
 * Two surfaces:
 *   - SERVER_EVENT_TYPES: emitted from API routes (already authenticated)
 *   - CLIENT_EVENT_TYPES: emitted from the browser via /api/events/track
 *
 * Adding a new event:
 *   1. Add the literal to the appropriate array below
 *   2. (Optional) map it in EVENT_COUNTER or EVENT_FUNNEL
 *   3. Emit it from the right surface
 */

export const SERVER_EVENT_TYPES = [
  // Signup funnel stages. `signup` (below) is the account-created milestone;
  // the three before it capture intent, email dispatch, and email return so
  // we can measure drop-off and time-to-verify per attempt.
  "signup_form_submitted",
  "signup_verification_sent",
  "signup_verification_clicked",
  "signup",
  "login",
  "login_failure",
  "logout",
  "password_change",
  "password_reset_request",
  "password_reset_complete",
  "email_verified",
  "rfp_applied",
  "rfp_unapplied",
  "rfp_in_progress",
  "rfp_in_progress_removed",
  "proposal_generated",
  "proposal_regenerated",
  "poe_generated",
  "poe_regenerated",
  "match_feedback_submitted",
  "match_feedback_removed",
  "contract_uploaded",
  "contract_deleted",
  "contract_updated",
  "profile_extracted",
  "profile_updated",
  "onboarding_completed",
] as const;

export const CLIENT_EVENT_TYPES = [
  "rfp_viewed",
  // Saved is currently a client-only signal because the Saved-RFPs persistence
  // layer is being migrated to Postgres (see project memory:
  // project_saved_rfps_postgres_migration). Move back to SERVER_EVENT_TYPES
  // once the rfp-status route handles `mark_saved` again.
  "rfp_saved",
  "rfp_unsaved",
  "filter_applied",
  "filter_cleared",
  "sort_changed",
  "search_submitted",
  "profile_section_edited",
  "page_viewed",
  "session_start",
  "session_heartbeat",
] as const;

export const ALL_EVENT_TYPES = [
  ...SERVER_EVENT_TYPES,
  ...CLIENT_EVENT_TYPES,
] as const;

export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export type EventType = (typeof ALL_EVENT_TYPES)[number];

const CLIENT_EVENT_TYPE_SET: ReadonlySet<string> = new Set(CLIENT_EVENT_TYPES);
export function isClientEventType(s: string): s is ClientEventType {
  return CLIENT_EVENT_TYPE_SET.has(s);
}

const ALL_EVENT_TYPE_SET: ReadonlySet<string> = new Set(ALL_EVENT_TYPES);
export function isEventType(s: string): s is EventType {
  return ALL_EVENT_TYPE_SET.has(s);
}

/**
 * Per-event payload shape. Kept as a generic record because event payloads
 * are highly heterogeneous; the values below document the expected shapes.
 *
 * Common fields:
 *   - rfpId?: string         — for RFP-related events
 *   - matchScore?: number    — match score at time of event
 *   - matchTier?: string     — "Excellent" | "Strong" | "Moderate" | "Low"
 *   - source?: string        — origin of action ("dashboard" | "home" | "rfp_detail")
 *   - sessionId?: string     — client-generated UUID for grouping
 *   - clientTimestamp?: string  — ISO when fired client-side (server stamp wins)
 *   - durationMs?: number    — for session_heartbeat / session_end
 *   - filterName?: string    — for filter_applied
 *   - filterValueCount?: number  — *count* of selected values, never the values
 *   - sortKey?: string       — for sort_changed
 *   - queryLength?: number   — for search_submitted (length only, not text)
 *   - sectionName?: string   — for profile_section_edited
 *   - pagePath?: string      — for page_viewed
 */
export interface EventPayload {
  [key: string]: unknown;
}

export interface TrackedEvent {
  type: EventType;
  payload?: EventPayload;
  /** Client-generated session ID, grouped server-side. */
  sessionId?: string;
  /** ISO timestamp from the client; informational only — server timestamp is authoritative. */
  clientTimestamp?: string;
}

/**
 * Maps an event to the top-level Number counter to increment on the
 * per-user KPI summary. Events without an entry here are still logged,
 * just not counted.
 */
export const EVENT_COUNTER: Partial<Record<EventType, string>> = {
  signup_form_submitted: "counter_signup_form_submits",
  signup_verification_sent: "counter_signup_verification_sends",
  signup_verification_clicked: "counter_signup_verification_clicks",
  login: "counter_logins",
  login_failure: "counter_login_failures",
  rfp_viewed: "counter_rfps_viewed",
  rfp_saved: "counter_rfps_saved",
  rfp_unsaved: "counter_rfps_unsaved",
  rfp_applied: "counter_rfps_applied",
  rfp_unapplied: "counter_rfps_unapplied",
  rfp_in_progress: "counter_rfps_in_progress",
  proposal_generated: "counter_proposals_generated",
  proposal_regenerated: "counter_proposals_regenerated",
  poe_generated: "counter_poes_generated",
  poe_regenerated: "counter_poes_regenerated",
  match_feedback_submitted: "counter_match_feedback",
  contract_uploaded: "counter_contracts_uploaded",
  contract_deleted: "counter_contracts_deleted",
  profile_extracted: "counter_profile_extractions",
  filter_applied: "counter_filters_applied",
  sort_changed: "counter_sorts_changed",
  search_submitted: "counter_searches",
  page_viewed: "counter_page_views",
  session_start: "counter_sessions",
};

/**
 * Maps an event to the funnel-checkpoint field on the per-user summary.
 * Funnel fields are written with `if_not_exists` so only the first occurrence
 * is recorded — subsequent firings don't overwrite.
 */
export const EVENT_FUNNEL: Partial<Record<EventType, string>> = {
  signup_form_submitted: "funnel_signup_form_submitted_at",
  signup_verification_sent: "funnel_signup_verification_sent_at",
  signup_verification_clicked: "funnel_signup_verification_clicked_at",
  signup: "funnel_signup_at",
  login: "funnel_first_login_at",
  rfp_viewed: "funnel_first_rfp_view_at",
  rfp_saved: "funnel_first_save_at",
  rfp_applied: "funnel_first_apply_at",
  proposal_generated: "funnel_first_proposal_at",
  poe_generated: "funnel_first_poe_at",
  profile_extracted: "funnel_profile_extracted_at",
  contract_uploaded: "funnel_first_contract_uploaded_at",
};
