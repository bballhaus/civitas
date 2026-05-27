# KPIs — Event Tracking & Funnel Analytics

How Civitas measures user behavior. Two DynamoDB tables for raw events
and per-user summaries; one daily S3 snapshot for the admin dashboard;
two read surfaces (the in-app `/admin/kpis` page and the
`npm run kpi:funnel` CLI).

## TL;DR

```bash
# Local funnel report — DynamoDB-backed
cd front_end
AWS_REGION=us-east-1 npm run kpi:funnel              # all users
AWS_REGION=us-east-1 npm run kpi:funnel <username>   # one user

# In-app dashboard (admin allowlist only)
https://civitas-ai.net/admin/kpis
```

The CLI returns four sections: signup funnel, time-to-verify, per-stage
onboarding actions, and stages ranked by drop-off. The web dashboard
adds total / DAU / WAU / MAU gauges, time-series charts (day / week /
month), event-type drill-down, and a "refresh now" button that
recomputes the daily snapshot inline.

---

## Infrastructure

| Component | Identifier | Notes |
|---|---|---|
| Events table | `civitas-kpi-events` | Raw append-only event log. TTL'd. PK=`USER#<username>`, SK=`<timestamp>#<eventId>`. |
| User summary table | `civitas-kpi-users` | Per-user aggregate (counters + funnel checkpoints). PK=`USER#<username>`. |
| Event-type GSI | `byEventType` on events table | PK=`TYPE#<eventType>`, SK=`<timestamp>#<username>#<eventId>`. Used for cross-user per-type queries. |
| Daily aggregate snapshots (S3) | `metrics/aggregate/latest.json` + `metrics/aggregate/daily/{YYYY-MM-DD}.json` | Written by `lib/kpi-aggregator.ts`; read by `/api/admin/kpis/` and `/api/admin/kpis/timeseries/`. |
| CloudFormation stack | `civitas-kpi` | Defined in [infra/kpi-tables.yaml](../infra/kpi-tables.yaml). Deploy via `aws cloudformation deploy --stack-name civitas-kpi --template-file infra/kpi-tables.yaml`. |
| IAM policy | `civitas-ses-and-kpi` (inline on `civitas-app` user) | Grants `dynamodb:PutItem/BatchWriteItem/UpdateItem/GetItem/Query/Scan/DescribeTable` on both tables + their indexes. |

Both DynamoDB tables: PAY_PER_REQUEST billing, SSE enabled, point-in-time
recovery enabled, 7-day backup retention.

---

## Event taxonomy

Definitions live in [front_end/src/lib/events.ts](../front_end/src/lib/events.ts).
Two surfaces:

- **Server events** — fired from API routes via
  `recordEvent(username, type, payload?)`. Authenticated by virtue of
  being inside a server handler.
- **Client events** — fired from the browser via `trackEvent(type,
  payload?)`, batched and POSTed to `/api/events/track`. Only the
  `CLIENT_EVENT_TYPES` allowlist is accepted (server events from the
  browser are rejected).

### Signup funnel (server)

Account creation is a two-phase, email-verify-before-create process.
Each stage is keyed on the prospective username so the whole funnel
joins together in the per-user summary.

| Stage | Event | Fires from | Counter | Funnel checkpoint |
|---|---|---|---|---|
| 1 | `signup_form_submitted` | `POST /api/auth/signup` after validation + uniqueness | `counter_signup_form_submits` | `funnel_signup_form_submitted_at` |
| 2 | `signup_verification_sent` | Same route, after `upsertPendingUser` + Resend `send` | `counter_signup_verification_sends` | `funnel_signup_verification_sent_at` |
| 3 | `signup_verification_clicked` | `GET /api/auth/verify-email` as soon as the pending row resolves | `counter_signup_verification_clicks` | `funnel_signup_verification_clicked_at` |
| 4 | `signup` | Same route, after `promotePendingUser` (account row exists) | — | `funnel_signup_at` |
| 5 | `onboarding_completed` | `POST /api/onboarding/state/` when the user clicks Finish | — | `funnel_onboarded_at` |

`signup_verification_sent` payload carries `{ emailSent: boolean }` —
`false` indicates `CIVITAS_FROM_EMAIL` was unset and the email helper
fell back to console logging (no Resend call). Use this to catch
env-var drift between Vercel scopes.

**Bypass flag**: when env var `SKIP_EMAIL_VERIFICATION=true` is set
on the signup route, the email step is skipped entirely. The signup
route creates the user immediately, sets the auth cookie, and returns
`{ bypassed: true }`; the signup page redirects straight to
`/onboarding`. Only `signup_form_submitted` and `signup` fire in this
mode (with `signup` carrying `{ verificationBypassed: true,
emailVerified: true }`).

### Onboarding stages (client)

The v2 guided wizard has 9 screens (see
[Architecture-v2 § 5](Architecture-v2.md#5-onboarding-flow)).
Per-stage telemetry comes from the wizard UI:

| Event | When | Payload |
|---|---|---|
| `onboarding_step_viewed` | Step becomes active (incl. resume on mount) | `{ step, stepName }` |
| `onboarding_step_advanced` | User clicks Next | `{ step, stepName }` |
| `onboarding_step_skipped` | User clicks Skip | `{ step, stepName }` |
| `onboarding_step_back` | User clicks Back | `{ step, stepName }` |
| `onboarding_step_dwell` | Step unmounts | `{ step, durationMs }` |
| `onboarding_field_touched` | Any input gains focus | `{ field }` |
| `onboarding_validation_error` | Form rejects a value | `{ field, code }` |

The first `step_viewed` marks `funnel_onboarding_started_at`. Per-stage
breakdowns come from filtering the event log by `payload.step` via the
`byEventType` GSI.

### Bidding tracker / RFP-status (server + client)

Status transitions land server-side via `PATCH /api/user/rfp-status/`
and emit one of:

| Event | Trigger |
|---|---|
| `rfp_saved` / `rfp_unsaved` | Save toggle |
| `rfp_applied` / `rfp_unapplied` | Legacy applied flag (kept for back-compat) |
| `rfp_in_progress` / `rfp_in_progress_removed` | In-progress transitions |
| `rfp_won` / `rfp_lost` / `rfp_no_bid` | Terminal pipeline states |
| `rfp_status_cleared` | Clear back to nothing |
| `match_feedback_submitted` / `match_feedback_removed` | Good / bad thumbs |

Client-side tracker telemetry:

| Event | Purpose |
|---|---|
| `tracker_column_viewed` | Which column (`saved`, `in_progress`, ...) is on screen |
| `tracker_status_changed_from_tracker` | Drag-drop status changes (vs. the detail page) |
| `tracker_filter_applied` | Tracker filter chip use |
| `tracker_note_added` / `tracker_note_edited` | Task notes |

### RFP detail engagement (client)

| Event | Purpose |
|---|---|
| `rfp_viewed` | Detail page mount (also writes `match_state.viewed_at` via `/api/rfp-views`) |
| `rfp_impression` | List-view impression with `position` |
| `rfp_section_expanded` | Which collapsible section was opened |
| `rfp_attachment_clicked` | Which attachment, with `hasMirror` flag |
| `rfp_external_link_clicked` | Outbound to portal |
| `rfp_dwell` | `durationMs` on the detail page (≥500 ms) |

### Home / nav (client)

`home_cta_clicked`, `home_widget_viewed`, `home_recent_match_clicked`,
`page_viewed`, `session_start`, `session_heartbeat`.

### Generation engagement

`proposal_generated`, `proposal_regenerated`, `proposal_copied`,
`proposal_downloaded`, `poe_generated`, `poe_regenerated`, `poe_copied`,
`poe_downloaded`. Counters and funnel checkpoints stay live so historical
data from the legacy `/dashboard` UI is still queryable; the active
product currently has no UI entry point firing these (see
[Retired Features](Retired-Features)).

### Profile / contracts

`contract_uploaded`, `contract_deleted`, `contract_updated`,
`profile_extracted`, `profile_updated`, `profile_section_edited`.

### Filters / search (client)

`filter_applied`, `filter_cleared`, `sort_changed`, `search_submitted`,
`search_result_count`.

The full event-type union is in
[`SERVER_EVENT_TYPES`](../front_end/src/lib/events.ts) and
[`CLIENT_EVENT_TYPES`](../front_end/src/lib/events.ts).

---

## Counters vs funnel checkpoints

Two columns appear on every user-summary row:

- **`counter_*`** — incremented on every event firing. Always grows.
  Cumulative per-user totals.
- **`funnel_*`** — first-occurrence ISO timestamp. Written with
  `if_not_exists`, so re-firing doesn't overwrite.

Map between events and these column names lives in `EVENT_COUNTER` /
`EVENT_FUNNEL` in [events.ts](../front_end/src/lib/events.ts). Events
without a mapping still hit the events table; they just don't update
the summary.

---

## The admin dashboard (`/admin/kpis`)

Live web view of the same data. Allowlist-gated by
[`lib/admin-auth.ts`](../front_end/src/lib/admin-auth.ts). The page
reads:

| API | Returns |
|---|---|
| `GET /api/admin/kpis/` | Most recent `metrics/aggregate/latest.json` snapshot. Returns `{ snapshot: null }` if no snapshot exists yet (fresh deploy). |
| `POST /api/admin/kpis/` | Recomputes the snapshot inline and returns the fresh result. |
| `GET /api/admin/kpis/timeseries/?granularity=day\|week\|month` | Reads the daily S3 archive and buckets headline metrics. |
| `GET /api/admin/events/?type=...` | Cross-user drill-down via the `byEventType` GSI. |

Headline metrics on the snapshot:

- Total users / DAU / WAU / MAU
- Signups in the last 24 h + cumulative
- RFP views / saves / applies in bucket
- Proposals / POEs generated (historical)
- Top filter / sort values
- Per-event rollup counts

`POST /api/admin/aggregate-kpis/` is the cron-secret-protected
equivalent of `POST /api/admin/kpis/` — same compute, different auth
surface for the unattended daily run.

Test users are excluded from rollups. The exclusion list combines a
hard-coded set in [`lib/test-users.ts`](../front_end/src/lib/test-users.ts)
(usernames + test-email patterns) with a Postgres-side join — any
`users` row whose email matches a test-email pattern is also excluded.

---

## The CLI funnel report

[`scripts/funnel-report.ts`](../front_end/scripts/funnel-report.ts),
exposed as `npm run kpi:funnel`. Four sections:

1. **Signup funnel (cumulative)** — for each of the six stages
   above, the count of users who reached it, with stage-to-stage and
   overall conversion %.
2. **Time to click verification email** — per-user duration between
   `funnel_signup_verification_sent_at` and
   `funnel_signup_verification_clicked_at`, sorted ascending, with
   median.
3. **Per-stage onboarding actions** — for each step 1..9: views /
   advances / skips / backs / advance rate.
4. **Stages ranked by drop-off** — same data sorted by advance rate
   ascending; the worst-performing screen surfaces first.

Pass a username to scope to one user. Pre-launch volumes fit in
memory; switch to parallel scan once the user table grows.

### Raw queries

For per-stage attribution beyond what the report gives you:

```bash
# All `step_skipped` events
aws dynamodb query \
  --table-name civitas-kpi-events \
  --index-name byEventType \
  --key-condition-expression "gsi1pk = :pk" \
  --expression-attribute-values '{":pk":{"S":"TYPE#onboarding_step_skipped"}}' \
  --region us-east-1
```

Filter the JSON output by `payload.step` to get per-step breakdowns.
The current report does this in TypeScript; reproduce in SQL once we
have a warehouse.

### What you can compute

| Metric | How |
|---|---|
| Form-to-account conversion | `count(funnel_signup_at) / count(funnel_signup_form_submitted_at)` |
| Email-click rate | `count(funnel_signup_verification_clicked_at) / count(funnel_signup_verification_sent_at)` |
| Median time-to-verify | median of `clicked_at − sent_at` for users with both |
| Per-stage drop-off | `1 − (advanced count / views count)` for that step |
| Skip rate per stage | `skipped count / views count` for that step |
| Backtrack rate per stage | `back count / views count` — high values flag confusing screens |
| Onboarding completion rate | `count(funnel_onboarded_at) / count(funnel_onboarding_started_at)` |

---

## Adding a new event

1. Add the string literal to the appropriate array in
   [events.ts](../front_end/src/lib/events.ts):
   - `SERVER_EVENT_TYPES` if firing from an API route
   - `CLIENT_EVENT_TYPES` if firing from the browser
2. (Optional) map it in `EVENT_COUNTER` to a `counter_*` field on the
   user summary
3. (Optional) map it in `EVENT_FUNNEL` to a `funnel_*` first-occurrence
   timestamp
4. Emit it from the right surface:
   - Server: `void recordEvent(username, "event_type", { ...payload })`
   - Client: `trackEvent("event_type", { ...payload })`
5. If the event needs to appear in the funnel report, add it to the
   constants block at the top of
   [funnel-report.ts](../front_end/scripts/funnel-report.ts)
6. If the event should appear in the admin dashboard, extend
   `lib/kpi-aggregator.ts` (rollups under `ROLLUP_EVENT_TYPES`).

`recordEvent` and `trackEvent` are fire-and-forget. Failures log a
warning but never block the request path.

---

## Operational notes

- **Resend delivery failures**: the email helper logs `[Email] Failed
  to send to <addr>` on failure. The `signup_verification_sent` event
  still fires (we're recording intent), so a divergence between the
  event count and Resend's delivery dashboard indicates a delivery
  rejection.
- **Pre-table-existence drop**: KPI events fired before the
  `civitas-kpi` stack was deployed were silently lost
  (`ResourceNotFoundException`). Going forward, missing events mean
  an IAM, network, or code bug — not a missing table.
- **TTL**: events table has a `ttl` attribute with DynamoDB TTL
  enabled. Default retention is `config.kpi.eventTtlDays` (90 days)
  set at write time in [event-log.ts](../front_end/src/lib/event-log.ts).
  User summary rows have no TTL — they persist for the life of the
  account.
- **Per-user PII**: event payloads must never include free-text user
  content (search queries, RFP titles, etc.). Use *counts* and *enum
  values* only. Existing payloads follow this discipline; see the
  `EventPayload` docblock in [events.ts](../front_end/src/lib/events.ts).
- **Snapshot back-pressure**: `lib/kpi-aggregator.ts` currently
  `Scan`s `civitas-kpi-users` rather than paginating. The user base is
  small enough that this is fine; the comment in the source flags the
  switch to parallel scan when it stops being.
