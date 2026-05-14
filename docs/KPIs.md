# KPIs — Event Tracking & Funnel Analytics

How Civitas measures user behavior. Two DynamoDB tables, a typed event taxonomy emitted from server + client, and a CLI report.

## TL;DR

```bash
cd front_end
AWS_REGION=us-east-1 npm run kpi:funnel              # all users
AWS_REGION=us-east-1 npm run kpi:funnel <username>   # one user
```

Returns four sections: signup funnel, time-to-verify, per-stage onboarding actions, and stages ranked by drop-off.

---

## Infrastructure

| Component | Identifier | Notes |
|---|---|---|
| Events table | `civitas-kpi-events` | Raw append-only event log. TTL'd. PK=`USER#<username>`, SK=`<timestamp>#<eventId>`. |
| User summary table | `civitas-kpi-users` | Per-user aggregate (counters + funnel checkpoints). PK=`USER#<username>`. |
| Event-type GSI | `byEventType` on events table | PK=`TYPE#<eventType>`, SK=`<timestamp>#<username>#<eventId>`. Used for cross-user per-type queries. |
| CloudFormation stack | `civitas-kpi` | Defined in [infra/kpi-tables.yaml](../infra/kpi-tables.yaml). Deploy via `aws cloudformation deploy --stack-name civitas-kpi --template-file infra/kpi-tables.yaml`. |
| IAM policy | `civitas-ses-and-kpi` (inline on `civitas-app` user) | Grants `dynamodb:PutItem/BatchWriteItem/UpdateItem/GetItem/Query/Scan/DescribeTable` on both tables + their indexes. |

Both tables: PAY_PER_REQUEST billing, SSE enabled, point-in-time recovery enabled, 7-day backup retention.

---

## Event taxonomy

Definitions live in [front_end/src/lib/events.ts](../front_end/src/lib/events.ts). Two surfaces:

- **Server events** — fired from API routes via `recordEvent(username, type, payload?)`. Authenticated by virtue of being inside a server handler.
- **Client events** — fired from the browser via `trackEvent(type, payload?)`, batched and POSTed to `/api/events/track`. Only the `CLIENT_EVENT_TYPES` allowlist is accepted (server events from the browser are rejected).

### Signup funnel (server)

Account creation is a two-phase process (email-verify-before-create). Each stage is keyed on the *prospective* username, so the whole funnel joins together in the per-user summary.

| Stage | Event | Fires from | Counter | Funnel checkpoint |
|---|---|---|---|---|
| 1 | `signup_form_submitted` | `POST /api/auth/signup` after validation + uniqueness checks | `counter_signup_form_submits` | `funnel_signup_form_submitted_at` |
| 2 | `signup_verification_sent` | Same route, after `upsertPendingUser` + SES `SendEmail` | `counter_signup_verification_sends` | `funnel_signup_verification_sent_at` |
| 3 | `signup_verification_clicked` | `GET /api/auth/verify-email` as soon as the pending row resolves | `counter_signup_verification_clicks` | `funnel_signup_verification_clicked_at` |
| 4 | `signup` | Same route, after `promotePendingUser` (account row exists) | — | `funnel_signup_at` |
| 5 | `onboarding_completed` | `POST /api/onboarding/state/` when the user clicks Finish | — | `funnel_onboarded_at` |

`signup_verification_sent` payload carries `{ emailSent: boolean }` — `false` indicates `CIVITAS_FROM_EMAIL` was unset and the email helper fell back to console logging (no SES call). Use this to catch env-var drift between Vercel scopes.

**Bypass flag**: when env var `SKIP_EMAIL_VERIFICATION=true` is set on the signup route, the email step is skipped entirely. The signup route creates the user immediately, sets the auth cookie, and returns `{ bypassed: true }`; the signup page reads that and redirects straight to `/onboarding`. In this mode only `signup_form_submitted` and `signup` fire (with `signup` carrying `{ verificationBypassed: true, emailVerified: true }`); `signup_verification_sent` and `signup_verification_clicked` are skipped because they didn't happen. Intended for use while SES is in sandbox; flip back to default once production access lands.

### Onboarding stages (client)

The v2 guided interview has 9 screens (see [Architecture-v2 § 5](Architecture-v2.md#5-onboarding-flow)). Per-stage telemetry comes from the wizard UI:

| Event | When | Payload |
|---|---|---|
| `onboarding_step_viewed` | Step becomes active (incl. resume on mount) | `{ step: number, stepName: string }` |
| `onboarding_step_advanced` | User clicks Next | `{ step, stepName }` |
| `onboarding_step_skipped` | User clicks Skip | `{ step, stepName }` |
| `onboarding_step_back` | User clicks Back | `{ step, stepName }` |

All four roll up into top-level counters (`counter_onboarding_step_views/advances/skips/backs`). The first `step_viewed` marks `funnel_onboarding_started_at`. Per-stage breakdowns come from filtering the event log by `payload.step` via the `byEventType` GSI — see "Querying" below.

### Other tracked events

Inherited from the v1 KPI infra. Not exhaustive — see [events.ts](../front_end/src/lib/events.ts) for the complete list.

| Event | Surface | Use |
|---|---|---|
| `login`, `login_failure`, `logout` | server | Auth health |
| `rfp_viewed`, `rfp_saved`, `rfp_unsaved`, `rfp_applied`, `rfp_unapplied`, `rfp_in_progress` | mixed | RFP funnel |
| `proposal_generated/regenerated`, `poe_generated/regenerated` | server | AI generation engagement |
| `match_feedback_submitted` | server | Thumbs-up/down on matches |
| `contract_uploaded/deleted/updated`, `profile_extracted`, `profile_updated` | server | Profile-build engagement |
| `filter_applied`, `filter_cleared`, `sort_changed`, `search_submitted` | client | Dashboard usage |
| `page_viewed`, `session_start`, `session_heartbeat` | client | Engagement signals |

---

## Counters vs. funnel checkpoints

Two columns appear on every user-summary row:

- **`counter_*`** — incremented on every event firing. Always grows. Cumulative-per-user totals.
- **`funnel_*`** — first-occurrence ISO timestamp. Written with `if_not_exists`, so re-firing doesn't overwrite.

Map between events and these column names lives in `EVENT_COUNTER` / `EVENT_FUNNEL` in [events.ts](../front_end/src/lib/events.ts). Events without a mapping still hit the events table; they just don't update the summary.

---

## Querying

### The CLI report

[`scripts/funnel-report.ts`](../front_end/scripts/funnel-report.ts), exposed as `npm run kpi:funnel`. Sections:

1. **Signup funnel (cumulative)** — for each of the six stages above, the count of users who reached it, with stage-to-stage and overall conversion %.
2. **Time to click verification email** — per-user duration between `funnel_signup_verification_sent_at` and `funnel_signup_verification_clicked_at`, sorted ascending, with median.
3. **Per-stage onboarding actions** — for each step 1..9: views / advances / skips / backs / advance rate.
4. **Stages ranked by drop-off** — same data sorted by advance rate ascending; the worst-performing screen surfaces first.

Pass a username to scope to one user. Pre-launch volumes fit in memory; switch to parallel scan once the user table grows.

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

Filter the JSON output by `payload.step` to get per-step breakdowns. The current report does this in TypeScript; reproduce in SQL once we have a warehouse.

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

1. Add the string literal to the appropriate array in [events.ts](../front_end/src/lib/events.ts):
   - `SERVER_EVENT_TYPES` if firing from an API route
   - `CLIENT_EVENT_TYPES` if firing from the browser
2. (Optional) map it in `EVENT_COUNTER` to a `counter_*` field on the user summary
3. (Optional) map it in `EVENT_FUNNEL` to a `funnel_*` first-occurrence timestamp
4. Emit it from the right surface:
   - Server: `void recordEvent(username, "event_type", { ...payload })`
   - Client: `trackEvent("event_type", { ...payload })`
5. If the event needs to appear in the funnel report, add it to the constants block at the top of [funnel-report.ts](../front_end/scripts/funnel-report.ts)

`recordEvent` and `trackEvent` are fire-and-forget. Failures log a warning but never block the request path.

---

## Operational notes

- **Sandbox suppression**: SES sends with no recipient verification (sandbox mode) get rejected at the SES boundary, not at the IAM boundary. They will *not* show up as bounces; instead `SendEmail` returns 400 and the email helper logs `[Email] Failed to send to <addr>`. The `signup_verification_sent` event still fires (we're recording intent), so a divergence between sends and SES `Delivery` metric indicates sandbox rejects.
- **Pre-table-existence drop**: KPI events fired before [the `civitas-kpi` stack](#infrastructure) was deployed were silently lost (`ResourceNotFoundException`). Going forward, missing events mean an IAM, network, or code bug — not a missing table.
- **TTL**: events table has a `ttl` attribute with DynamoDB TTL enabled. Default retention is set at write time in [event-log.ts](../front_end/src/lib/event-log.ts). User summary rows have no TTL — they persist for the life of the account.
- **Per-user PII**: event payloads must never include free-text user content (search queries, RFP titles, etc.). Use *counts* and *enum values* only. Existing payloads follow this discipline; see the `EventPayload` docblock in [events.ts](../front_end/src/lib/events.ts).
