# Daily roundup notifications

Wires up the morning RFP digest that users opt into on the final onboarding
screen. The hard work — finding due users in their local 7am, scoring open
RFPs, filtering to unviewed >75% matches, sending via SES — lives in the
Next.js app at `front_end/src/app/api/cron/daily-roundup/route.ts`. This
directory contains only the AWS Lambda shim that EventBridge fires hourly.

## Architecture

```
EventBridge (rate(1 hour))
   │
   ▼
Lambda (notifications/lambda.mjs)
   │  POST + Bearer CIVITAS_CRON_SECRET
   ▼
Next.js: /api/cron/daily-roundup
   ├── reads profiles where daily_roundup_enabled = true
   ├── filters to users whose local hour == 7
   ├── computes matches via matching-v2.ts
   ├── filters out match_state rows where viewed_at IS NOT NULL
   └── SES sends via lib/email.ts → sendDailyRoundupEmail
```

The Lambda is intentionally trivial — it only makes one HTTP call. All
business logic stays in the Next.js app so it can reuse the existing
matcher, schema, and SES wiring instead of duplicating them.

## Deploy

### 1. Set env vars on the Next.js host (Vercel dashboard)

```
CIVITAS_CRON_SECRET=<long random string, e.g. `openssl rand -hex 32`>
CIVITAS_APP_ORIGIN=https://civitas-ai.net            # used to build email links
CIVITAS_FROM_EMAIL=...                               # already required for verification/reset
```

### 2. Create the Lambda

```sh
cd infra/notifications
zip lambda.zip lambda.mjs
aws lambda create-function \
  --function-name civitas-daily-roundup \
  --runtime nodejs20.x \
  --role arn:aws:iam::<acct>:role/civitas-lambda-basic \
  --handler lambda.handler \
  --zip-file fileb://lambda.zip \
  --timeout 60 \
  --environment "Variables={CIVITAS_CRON_URL=https://civitas-ai.net/api/cron/daily-roundup,CIVITAS_CRON_SECRET=<same secret>}"
```

The IAM role only needs the basic Lambda execution policy (CloudWatch logs).
It does not touch RDS, S3, or SES directly — the Next.js host does.

### 3. Create the EventBridge rule

```sh
aws events put-rule \
  --name civitas-daily-roundup-hourly \
  --schedule-expression "rate(1 hour)"

aws events put-targets \
  --rule civitas-daily-roundup-hourly \
  --targets "Id=1,Arn=arn:aws:lambda:us-east-1:<acct>:function:civitas-daily-roundup"

aws lambda add-permission \
  --function-name civitas-daily-roundup \
  --statement-id allow-eventbridge \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-east-1:<acct>:rule/civitas-daily-roundup-hourly
```

### 4. Verify

```sh
# Manually invoke the Lambda once:
aws lambda invoke --function-name civitas-daily-roundup /tmp/out.json
cat /tmp/out.json
```

The cron route is idempotent — invoking it off-hour returns
`{ ok: true, evaluated: 0, sent: 0 }` because no user is at local 7am.
To smoke-test the actual sending, temporarily set your own profile's
`daily_roundup_timezone` to a timezone where it's currently 7am and call
the route directly (Bearer-authed).

## Why a Lambda at all?

We could point EventBridge straight at the Next.js route via API
Destinations, skipping Lambda. The Lambda exists because:
- EventBridge API Destinations don't surface response bodies in
  CloudWatch as cleanly as Lambda does — debugging is harder.
- A Lambda lets us add per-invocation retry logic and alarms if the
  Next.js host is briefly unreachable.

If you outgrow the shim and want the cron to live entirely inside AWS
(e.g., to decouple from the Next.js host's uptime), the route logic in
`front_end/src/app/api/cron/daily-roundup/route.ts` is the unit you'd
port — everything outside that file is already AWS-side.

## Other crons that reuse this Lambda shim

`lambda.mjs` only knows two env vars (`CIVITAS_CRON_URL`,
`CIVITAS_CRON_SECRET`), so any Next.js cron route guarded by the same
shared bearer can be wired up by deploying a second copy of the same
function with a different URL.

### `civitas-critique-rfp-tags` (daily Sonnet audit of NAICS tags)

Audits the Haiku tags the sync-rfp-cache cron writes. Sonnet caught ~41%
disagreements in the bulk backfill; running daily keeps fresh scrapes
gradually corrected without slowing the live populate→tag→embed loop.

```sh
zip lambda.zip lambda.mjs
aws lambda create-function \
  --function-name civitas-critique-rfp-tags \
  --runtime nodejs20.x \
  --role arn:aws:iam::<acct>:role/civitas-lambda-basic \
  --handler lambda.handler \
  --zip-file fileb://lambda.zip \
  --timeout 300 \
  --environment "Variables={CIVITAS_CRON_URL=https://civitas-ai.net/api/cron/critique-rfp-tags,CIVITAS_CRON_SECRET=<same secret>}"

aws events put-rule \
  --name civitas-critique-rfp-tags-daily \
  --schedule-expression "cron(0 10 * * ? *)"   # 10am UTC = 3am PT

aws events put-targets \
  --rule civitas-critique-rfp-tags-daily \
  --targets "Id=1,Arn=arn:aws:lambda:us-east-1:<acct>:function:civitas-critique-rfp-tags"

aws lambda add-permission \
  --function-name civitas-critique-rfp-tags \
  --statement-id allow-eventbridge \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-east-1:<acct>:rule/civitas-critique-rfp-tags-daily
```

Lambda timeout is bumped to 300s to match the Vercel `maxDuration` on the
route (Sonnet is slower per call than Haiku). The Lambda itself does no
work besides waiting on the HTTP response, so the higher timeout is free.
