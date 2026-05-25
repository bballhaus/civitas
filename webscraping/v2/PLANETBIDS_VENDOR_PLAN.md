# PlanetBids Vendor Registration — Plan

> **Status (2026-05-25):** **Paused.** PlanetBids-sourced RFPs are hidden
> from all user-facing surfaces (matches list, RFP detail, saved/tracker,
> daily roundup digest) via `front_end/src/lib/rfp-source-visibility.ts`.
> Scrapers continue to run on the 12h schedule and write to `rfp_cache`,
> so the data is preserved for resume. Resuming PB on the site requires a
> business conversation with PlanetBids about per-bid attachment access
> (see Risks & open questions below) — without their `*`-gated docs we
> can't reliably score certifications / bonding / scope, so showing PB
> matches would mislead users.

**Goal (when resumed):** Register the shared Civitas vendor account on
each of the 41 PlanetBids agency portals in `PLANETBIDS_AGENCIES`.

**Important caveat (must read first).** Per-agency vendor registration
does **not** unlock private RFP PDFs on PlanetBids. Document gating is
**per-bid**: clicking "Download" on a `*`-prefixed (private) document
opens a "Become a Prospective Bidder" modal that registers your account
against that specific bid. The vendor flag on each portal is a no-op for
downloads (`webscraping/v2/scrapers/planetbids.py` documents this in the
`vendor_registered` comment block).

What vendor registration *does* get us:

- Account is visible in each agency's vendor search/directory.
- Notification subscriptions (some agencies email new-bid alerts to
  registered vendors).
- Eligibility to opt into per-bid Prospective Bidder enrollment when a
  specific RFP justifies the public-disclosure trade-off.
- A clean "we've shown up" presence in 41 agency procurement systems.

The actual PDF-unlock lever is still per-bid PB enrollment, which is a
ToS / public-disclosure decision flagged for legal review separately.

---

## PII handling

The vendor-registration flow needs sensitive company information that
PlanetBids requires on the registration form. We collect this **once,
locally**, and never commit/upload it.

### Vendor profile file (`webscraping/vendor_profile.json`)

- Location: repo root, **gitignored** (add to `.gitignore`).
- Format: a single JSON document with fields keyed by canonical
  PlanetBids form-field names (see Field Schema below).
- Populated by Brooke manually. Script reads it from disk only.
- **Never** uploaded to S3, **never** synced to Secrets Manager unless
  explicitly opted in (Phase 2.5).

### Field schema (informed by a sample PlanetBids vendor form)

```json
{
  "legal_company_name": "Civitas LLC",
  "dba": null,
  "tax_id_type": "EIN",         // or "SSN" — affects which field PB shows
  "tax_id_value": "REDACTED",   // never log this verbatim
  "duns_number": "REDACTED",
  "business_type": "LLC",
  "mailing_address": {
    "street": "...",
    "city": "...",
    "state": "CA",
    "zip": "..."
  },
  "billing_address": null,        // null = same as mailing
  "primary_contact": {
    "name": "...",
    "title": "...",
    "email": "...",
    "phone": "..."
  },
  "naics_codes": ["541512", "..."],
  "uses_naics": true,
  "certifications": [
    {"name": "DBE", "issuer": "CA UCP", "expires": "2027-08-15"}
  ],
  "service_categories": [],
  "diversity_classifications": []   // SBE/DBE/MBE/WBE/etc. — self-attest
}
```

The runner translates this canonical shape into agency-specific form
field IDs via a per-agency mapping (Phase 2 below).

### Logging & audit

Audit log structure: `s3://civitas-ai/scrapes/v2/vendor_registration_audit/{agency}/{timestamp}.json`

Contents per submission:

- `agency`, `portal_url`, `submitted_at`, `submission_hash`
- `fields_submitted`: the form field names that were filled (no values
  for sensitive fields — only counts and hashes)
- `result`: `pending_email_confirmation` / `accepted` / `error`
- `screenshot_uri`: optional S3 link to a pre-submission screenshot
  (also sensitive — store in private prefix)
- Hash of vendor_profile.json used (so we can correlate registrations
  to a profile version without storing the profile content)

Tax ID and DUNS values **are never written to S3, logs, or the audit
trail**. The audit log only confirms a field was supplied.

---

## Phases

### Phase 0 — Discovery (no PII required)

Read-only. Determines current registration state on each portal.

- `scripts/planetbids_audit_registration.py`
- For each of 41 portals, log in with shared account from
  `civitas/scraping/planetbids` (Secrets Manager), navigate to the
  vendor profile / account page, detect whether the account is
  registered with this agency.
- Output: `s3://civitas-ai/scrapes/v2/registry/planetbids_vendor_state.json`
  — `{agency: {registered: bool, registration_url: str, last_checked_at}}`.

Acceptance: state file exists for all 41 agencies; no PII touched.

### Phase 1 — Vendor profile structure

- Add `vendor_profile.json` template/example to docs/.
- Add `vendor_profile.json` to `.gitignore`.
- Build a Pydantic schema (`webscraping/v2/models.py`) so the loader
  validates Brooke's hand-filled JSON.
- Add a `load_vendor_profile()` helper that:
  - Refuses to log field values.
  - Hashes the document and returns the hash so audit logs can
    correlate without exposing data.

Acceptance: schema validates, load helper redacts in any error path,
gitignore confirmed.

### Phase 2 — Per-agency form mapping (pilot)

Each PlanetBids agency uses the same template but customizes fields,
required-ness, and option lists. We can't fan out blindly.

- Pick 2-3 pilot agencies. Recommended: `planetbids_maywood` (small,
  low traffic), `planetbids_san_marcos`, `planetbids_goleta`.
- Run `scripts/planetbids_register_interactive.py {agency}`:
  - Headed Playwright (browser visible).
  - For each form field, the script reads the canonical profile, looks
    up the agency-specific mapping, and either auto-fills or prompts
    Brooke if no mapping exists.
  - Each auto-fill is announced ("Filling email = b***@gmail.com")
    before action; Brooke can abort.
  - At submission: full-page screenshot, pre-submit pause for
    final approval, then submit.
- Capture the discovered field mapping into
  `webscraping/v2/planetbids_registration_specs/{agency}.json`.

Acceptance: 2-3 agencies registered, mappings captured, no surprises
in the submitted forms.

### Phase 3 — Batch run (still supervised, sequential)

- `scripts/planetbids_register_batch.py`:
  - Reads `planetbids_vendor_state.json` to skip already-registered
    agencies.
  - Iterates remaining agencies in alphabetical order, headed mode by
    default.
  - For each: load the agency spec from
    `planetbids_registration_specs/`, auto-fill from
    `vendor_profile.json`, prompt for OK, submit, log.
  - Inter-agency pause (≥ 60s) to avoid rate limits on the shared IP.
  - **Stop on first unexpected page state** — never push blindly.
- Email confirmation handling: PlanetBids sends a confirmation email
  per agency. Brooke clicks confirms manually; the script can poll
  the state file later to flip `registered: true` once the
  confirmation lands (Phase 4).

Acceptance: 36-39 remaining agencies registered without an unattended
abort.

### Phase 4 — Confirmation polling & state refresh

- A monitor mode (`mode=monitor` or a standalone script) that re-runs
  Phase 0's audit script weekly, flips `registered` flags in the state
  file as agencies acknowledge.
- Surface count of confirmed/pending registrations in the existing
  `mode=monitor` Lambda response.

---

## What lives where

| Artifact | Location | Sensitive? |
|---|---|---|
| Shared PlanetBids credentials | AWS Secrets Manager (`civitas/scraping/planetbids`) — already exists | Yes |
| Vendor profile (PII) | `webscraping/vendor_profile.json`, local-only, gitignored | **Highly** |
| Per-agency field mappings | `webscraping/v2/planetbids_registration_specs/{agency}.json`, committed | No (no values, just field names/types) |
| Vendor registration state | `s3://civitas-ai/scrapes/v2/registry/planetbids_vendor_state.json` | Low (just `{registered: bool}`) |
| Submission audit log | `s3://civitas-ai/scrapes/v2/vendor_registration_audit/` | Medium (field names + hashes, no values) |
| Pre-submit screenshots | `s3://civitas-ai/scrapes/v2/vendor_registration_audit/screenshots/` | **High** (contain form values) — encrypt or skip |

---

## Risks & open questions

1. **PlanetBids ToS**: Shared vendor account being registered as Civitas
   across 41 agencies must comply with each agency's vendor terms.
   Some agencies require a unique business email per registration; the
   shared `civitas/scraping/planetbids` username may be insufficient.
2. **Rate limiting**: 41 sequential registrations from one IP/account
   in a short window risks throttling/lockout. Spread over days, not
   minutes.
3. **Notification spam**: registered = subscribed to new-bid emails by
   default on many agencies. Decide ahead of time whether to opt-in
   to notifications or unsubscribe immediately post-registration.
4. **Account uniqueness**: some agencies bind the vendor account to a
   single contact email. If the same shared email is reused 41 times,
   later registrations may fail. Need Brooke to confirm whether the
   shared account is per-agency-unique or globally unique.
5. **State refresh cadence**: agencies may de-register inactive
   vendors. Phase 4 monitor handles this but Brooke needs to decide
   whether to auto-re-register or alert only.

## What I will NOT do without explicit go-ahead

- Run any of this from Lambda (cron-fanned-out browser logins to
  agency portals is far riskier than the scrape path).
- Encrypt and store `vendor_profile.json` contents in Secrets Manager.
  (The plan suggests this as Phase 2.5 if Brooke opts in, not by
  default.)
- Submit registrations on agencies that don't already have a `*` flag
  somewhere in their UI indicating shared accounts are permitted.
- Bulk-submit (Phase 3) before pilot (Phase 2) signs off on at least
  2 agencies.
