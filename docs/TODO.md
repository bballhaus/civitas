# TODO — Market Readiness

Tracking remaining work against the [priority list](../README.md):
matching quality → correctness → explainability → security → speed →
completeness → documentation.

Cross-references to active retirements / deferrals live in
[Retired Features](Retired-Features).

---

## Matching quality (priority 1)

- [ ] **Match impression + outcome logging** —
      [Matching-Finetuning § 3](Matching-Finetuning.md#3-data-model)
      `match_impressions` / `match_outcomes` tables, plus the
      exploration-slot wiring. Not started; required before any
      weight-learning.
- [ ] **Background match scoring for new RFPs** — `rfp_cache` rows
      added by a scrape are scored on first user demand and a
      fire-and-forget background populate via
      `lib/match-rescore-trigger.ts`. Convert into a scheduled cron
      so users always land on pre-scored results.
- [ ] **Contract duration filter on `/matches`** — needs the
      `contract_duration` column populated by enrichment + a UI
      filter chip. Currently we extract `contract_start` /
      `contract_end` separately; consolidate.
- [ ] **PlanetBids document unblock** — per-agency vendor
      registration would unlock PDF-extracted requirements
      (NAICS, licenses, certs, deliverables) for ~43 portals. Legal /
      ops decision; tracked in
      [COVERAGE.md](../webscraping/v2/COVERAGE.md).
- [ ] **Agentic LA + SF on Lambda** — LA's `labavn.org` DNS-fails;
      SF URL is 404. Re-onboard via `{"mode":"discover"}` +
      `{"mode":"onboard"}` when working endpoints are confirmed.
- [ ] **OpenGov Cloudflare bypass** — Pasadena (and any future
      OpenGov onboards) blocked. Investigate API-only path or a
      bypass service.

## Correctness (priority 2)

- [ ] **`feedback-driven weight tuning`** — once impression logs land,
      empirically learn the v2 weight vector per
      [Matching-Finetuning § 4](Matching-Finetuning.md#4-the-model).
- [ ] **NAICS critic ground-truth eval set** — pick ~100 RFPs,
      hand-label primary + secondary NAICS, measure Haiku and Sonnet
      agreement / accuracy. Currently we trust Sonnet over Haiku on
      disagreement without absolute calibration.
- [ ] **Profile aggregation tests** — golden fixtures for
      `lib/claim-acceptance.ts` covering merge / dedup / overwrite
      decisions on each `field_path`.
- [ ] **Saved RFPs → Postgres migration** — generated POE / proposal
      markdown + match-feedback snapshot still live in the per-user S3
      JSON blob via [`lib/user-data.ts`](../front_end/src/lib/user-data.ts)
      and [`lib/rfp-status.ts`](../front_end/src/lib/rfp-status.ts).
      `match_state` already carries the feedback snapshot in v2
      columns; finish the migration so S3 user-data can be retired.

## Explainability (priority 3)

- [ ] **Profile completeness indicator** — surface what fields are
      empty and how each empty field affects match quality.
      `profiles.completeness_score` exists; needs UI.
- [ ] **Per-field provenance in `/profile/v2`** — `/api/profile/provenance`
      exists but the UI doesn't yet render the "evidenced by" link
      next to every field.
- [ ] **Citation hover-over on match list** — extend the per-RFP card
      to surface the strongest citation without requiring a click into
      detail.

## Security (priority 4)

- [ ] **IAM permission scoping** — CodeBuild / CloudWatch policies use
      `Resource: "*"` — scope to specific resources before production
      tightening (kept for dev flexibility).
- [ ] **AWS Secrets Manager** — Move Lambda LLM keys (`ANTHROPIC_API_KEY`,
      `GROQ_API_KEY`, `VOYAGE_API_KEY`) out of env vars.
- [ ] **CSRF tokens** — `SameSite=Strict` cookies mitigate same-origin
      CSRF; explicit tokens still deferred. Low priority.
- [ ] **Style nonce support** — Tailwind v4 still requires
      `'unsafe-inline'` for `style-src`. Track upstream.
- [ ] **S3 backup strategy** — set up cross-region replication or
      scheduled snapshots for `civitas-ai`.

## Speed (priority 5)

- [ ] **Match list initial render** — `/matches` first paint is
      dominated by `/api/match` + profile fetch; investigate streaming
      the cached rows from `match_state` before live scoring backfills.
- [ ] **Tracker calendar virtualization** — FullCalendar renders every
      key date in the user's pipeline; profile and decide on
      virtualization at 100+ saved RFPs.
- [ ] **Vercel function cold starts** — profile the slowest cron and
      `/api/match` paths after the next deploy.

## Completeness (priority 6)

- [ ] **End-to-end tests** — full user flow: signup → verify →
      onboard → upload → claim review → matches → save → tracker.
- [ ] **API route unit tests** — coverage on each `/api/*` route with
      edge cases.
- [ ] **Load testing** — verify Vercel function limits under concurrent
      load.
- [ ] **Error monitoring** — Sentry or Vercel Analytics for production
      error tracking (Vercel logs alone don't cluster).
- [ ] **Decide on AI Proposal / POE generation** — the routes
      `/api/generate-proposal` and `/api/generate-plan-of-execution`
      remain wired up but have no UI entry point
      (see [Retired Features](Retired-Features)). Either re-surface
      on `/matches/[rfpId]` with a feature flag, or delete the backend
      and the `generated_documents` table.

## Documentation (priority 7)

- [ ] **Per-source coverage snapshot in `/admin/kpis`** — surface the
      `webscraping/v2/scrapes/v2/_summary.json` health rollup inside
      the admin dashboard so we notice stale scrapers without manually
      hitting S3.
- [ ] **Operator runbook** — concrete "what to do when X" entries for
      cron failures, Resend bounce volume spikes, RDS connection
      saturation, and Vercel deploy rollback.
