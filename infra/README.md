# Civitas Infrastructure

Shared AWS infra-as-code that isn't tied to the scraper Lambda
(see `webscraping/v2/deploy/template.yaml` for that).

## KPI tables (`kpi-tables.yaml`)

Two DynamoDB tables that back the internal KPI tracking system:

- **`civitas-kpi-events`** — raw event log, partitioned per user. TTL-expired after 90 days.
  - `pk = USER#{username}`, `sk = EVENT#{ISO_timestamp}#{eventId}`
  - GSI `byEventType` for cross-user queries (e.g. "all rfp_applied this week")
- **`civitas-kpi-users`** — per-user aggregated summary (counters + funnel timestamps).
  - `pk = USER#{username}`
  - GSI `byCohort` keyed on signup-week for retention math

Both: encryption at rest (SSE), point-in-time recovery, on-demand billing.

### Deploy

```bash
aws cloudformation deploy \
  --template-file infra/kpi-tables.yaml \
  --stack-name civitas-kpi-tables \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM
```

For staging:
```bash
aws cloudformation deploy \
  --template-file infra/kpi-tables.yaml \
  --stack-name civitas-kpi-tables-staging \
  --parameter-overrides EnvSuffix=-staging \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM
```

### IAM for Vercel

The Vercel function role needs these actions on both tables (and the GSIs):

- `dynamodb:PutItem`
- `dynamodb:UpdateItem`
- `dynamodb:GetItem`
- `dynamodb:Query`
- `dynamodb:Scan` (used by the daily aggregator)
- `dynamodb:BatchWriteItem`

Add to the AWS user/role whose keys are in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

### Daily aggregator (Vercel Cron)

A cron in `front_end/vercel.json` triggers `GET /api/admin/aggregate-kpis`
once per day at 08:00 UTC. The endpoint scans `civitas-kpi-users`, computes
the rolled-up summary, and writes it to S3:

- `metrics/aggregate/daily/{YYYY-MM-DD}.json` — historical snapshot
- `metrics/aggregate/latest.json` — canonical current view

The endpoint requires `Authorization: Bearer ${CRON_SECRET}`. Set the
`CRON_SECRET` env var in Vercel project settings; Vercel Cron sends this
header automatically.

**Manual run** (one-off backfill or local check):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
     https://<deployment>/api/admin/aggregate-kpis
```

### Viewing KPIs

There is no admin UI — read the JSON directly:

```bash
# Latest summary
aws s3 cp s3://civitas-ai/metrics/aggregate/latest.json -

# A specific day
aws s3 cp s3://civitas-ai/metrics/aggregate/daily/2026-04-27.json -

# Per-user raw events (last 7 days, by user)
aws dynamodb query \
  --table-name civitas-kpi-events \
  --key-condition-expression "pk = :u AND begins_with(sk, :p)" \
  --expression-attribute-values '{":u":{"S":"USER#alice"},":p":{"S":"EVENT#"}}' \
  --region us-east-1
```

The summary shape is documented in
[`front_end/src/lib/kpi-aggregator.ts`](../front_end/src/lib/kpi-aggregator.ts)
(`KpiSummary` interface).
