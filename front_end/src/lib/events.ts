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
  "rfp_saved",
  "rfp_unsaved",
  "rfp_applied",
  "rfp_unapplied",
  "rfp_in_progress",
  "rfp_in_progress_removed",
  "rfp_won",
  "rfp_lost",
  "rfp_no_bid",
  "rfp_status_cleared",
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
  "error_occurred",
] as const;

export const CLIENT_EVENT_TYPES = [
  // Per-step onboarding telemetry. Each event payload carries:
  //   step:     number  // 1..TOTAL_STEPS
  //   stepName: string  // STEP_META.short ("Identity", "Specialties", ...)
  // Per-stage breakdowns come from filtering the event log by
  // payload.step (via the byEventType GSI); the user-level counters below
  // are just totals across all stages.
  "onboarding_step_viewed",
  "onboarding_step_advanced",
  "onboarding_step_skipped",
  "onboarding_step_back",
  "onboarding_step_dwell",
  "onboarding_validation_error",
  "onboarding_field_touched",
  "rfp_viewed",
  "rfp_impression",
  "rfp_section_expanded",
  "rfp_attachment_clicked",
  "rfp_external_link_clicked",
  "rfp_dwell",
  "proposal_copied",
  "proposal_downloaded",
  "poe_copied",
  "poe_downloaded",
  "filter_applied",
  "filter_cleared",
  "sort_changed",
  "search_submitted",
  "search_result_count",
  "profile_section_edited",
  "home_cta_clicked",
  "home_widget_viewed",
  "home_recent_match_clicked",
  "tracker_column_viewed",
  "tracker_status_changed_from_tracker",
  "tracker_filter_applied",
  "tracker_note_added",
  "tracker_note_edited",
  "page_viewed",
  "session_start",
  "session_heartbeat",
  "error_occurred",
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
 *   - filterName?: string    — for filter_applied / filter_cleared
 *   - filterValueCount?: number  — count of selected values
 *   - filterValues?: string  — selected values joined by "|", trimmed to fit
 *                              the 200-char sanitizer cap. Allowlisted filters
 *                              only (status/agency/industry/etc.) — never free-text.
 *   - sortKey?: string       — for sort_changed
 *   - direction?: string     — "asc" | "desc" for sort_changed
 *   - queryLength?: number   — for search_submitted (length only, not text)
 *   - resultCount?: number   — for search_result_count
 *   - zeroResults?: boolean  — for search_result_count
 *   - sectionName?: string   — for profile_section_edited
 *   - pagePath?: string      — for page_viewed
 *   - durationMs?: number    — for *_dwell events (time spent on step/page)
 *   - field?: string         — for onboarding_field_touched / validation_error
 *   - code?: string          — error code for onboarding_validation_error
 *   - position?: number      — index in list (0-based) for impressions / clicks
 *   - section?: string       — RFP detail section key ("attachments" | "scope" | ...)
 *   - attachmentIndex?: number   — index of attachment for rfp_attachment_clicked
 *   - hasMirror?: boolean    — whether the attachment had a mirrored S3 copy
 *   - source?: string        — origin (already documented above)
 *   - matchTier?: string     — already documented above
 *   - ctaKey?: string        — homepage CTA identifier
 *   - widgetKey?: string     — homepage widget identifier
 *   - columnKey?: string     — tracker column key ("saved" | "in_progress" | ...)
 *   - from?: string / to?: string  — RFP status transition (tracker_status_changed_from_tracker)
 *   - source?: string        — for error_occurred: where the error came from
 *                              (e.g. "api/generate-proposal", "client/global",
 *                              "scrape/enrich"). Keep stable for rollups.
 *   - code?: string          — for error_occurred: short stable code
 *                              (e.g. "GROQ_TIMEOUT", "FETCH_FAILED", "UNHANDLED").
 *   - message?: string       — for error_occurred: human-readable detail,
 *                              truncated to MAX_STRING_LEN in the sanitizer.
 *   - severity?: string      — for error_occurred: "warn" | "error" | "fatal"
 *                              (default "error").
 *   - statusCode?: number    — for error_occurred from HTTP routes.
 *   - context?: string       — for error_occurred: optional short context
 *                              (rfpId, route path, step name).
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
  onboarding_step_viewed: "counter_onboarding_step_views",
  onboarding_step_advanced: "counter_onboarding_step_advances",
  onboarding_step_skipped: "counter_onboarding_step_skips",
  onboarding_step_back: "counter_onboarding_step_backs",
  login: "counter_logins",
  login_failure: "counter_login_failures",
  rfp_viewed: "counter_rfps_viewed",
  rfp_saved: "counter_rfps_saved",
  rfp_unsaved: "counter_rfps_unsaved",
  rfp_applied: "counter_rfps_applied",
  rfp_unapplied: "counter_rfps_unapplied",
  rfp_in_progress: "counter_rfps_in_progress",
  rfp_won: "counter_rfps_won",
  rfp_lost: "counter_rfps_lost",
  rfp_no_bid: "counter_rfps_no_bid",
  proposal_generated: "counter_proposals_generated",
  proposal_regenerated: "counter_proposals_regenerated",
  poe_generated: "counter_poes_generated",
  poe_regenerated: "counter_poes_regenerated",
  match_feedback_submitted: "counter_match_feedback",
  contract_uploaded: "counter_contracts_uploaded",
  contract_deleted: "counter_contracts_deleted",
  profile_extracted: "counter_profile_extractions",
  filter_applied: "counter_filters_applied",
  filter_cleared: "counter_filters_cleared",
  sort_changed: "counter_sorts_changed",
  search_submitted: "counter_searches",
  page_viewed: "counter_page_views",
  session_start: "counter_sessions",
  rfp_impression: "counter_rfp_impressions",
  rfp_section_expanded: "counter_rfp_sections_expanded",
  rfp_attachment_clicked: "counter_rfp_attachments_clicked",
  rfp_external_link_clicked: "counter_rfp_external_links",
  proposal_copied: "counter_proposals_copied",
  proposal_downloaded: "counter_proposals_downloaded",
  poe_copied: "counter_poes_copied",
  poe_downloaded: "counter_poes_downloaded",
  home_cta_clicked: "counter_home_ctas",
  home_recent_match_clicked: "counter_home_recent_match_clicks",
  tracker_column_viewed: "counter_tracker_column_views",
  tracker_status_changed_from_tracker: "counter_tracker_status_changes",
  tracker_filter_applied: "counter_tracker_filters",
  tracker_note_added: "counter_tracker_notes_added",
  tracker_note_edited: "counter_tracker_notes_edited",
  onboarding_validation_error: "counter_onboarding_validation_errors",
  onboarding_field_touched: "counter_onboarding_field_touches",
  error_occurred: "counter_errors",
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
  // First step_viewed event marks onboarding entry. The completion timestamp
  // is captured by `onboarding_completed` (already fires from /api/onboarding
  // state POST). Time-per-step is derived from the event log, not stored here.
  onboarding_step_viewed: "funnel_onboarding_started_at",
  login: "funnel_first_login_at",
  rfp_viewed: "funnel_first_rfp_view_at",
  rfp_saved: "funnel_first_save_at",
  rfp_applied: "funnel_first_apply_at",
  proposal_generated: "funnel_first_proposal_at",
  poe_generated: "funnel_first_poe_at",
  profile_extracted: "funnel_profile_extracted_at",
  contract_uploaded: "funnel_first_contract_uploaded_at",
};
