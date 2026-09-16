# studio-agent-telemetry-poster

Azure Function App: ingests Studio Agent telemetry (queue + webhook) into
Table Storage, serves the dashboard API, and sends the weekly HR insight
digest. Deploy: `func azure functionapp publish studioagent-telemetry-poster`.

## Functions

- `postTelemetryToRelevance` — queue trigger (`bot-telemetry`): decodes and
  stores every bot event into `telemetryevents` (idempotent via rowKey dedup).
- `analyticsWebhook` — HTTP ingest for tool/turn/sync/escalation events.
- `dailyAggregation` — timer, 02:00 UTC: daily metrics into `telemetrymetrics`.
- `weeklyInsight` — timer, Mon 06:00 UTC: composes the weekly demand/gap
  digest per tenant into `weeklyinsight`, then sends unsent digests (≤14 days
  old) by email via Azure Communication Services. Idempotent (`sent` flag),
  failures stored on the row (`sendError`) and retried the following week.
- `dashboardApi` — HTTP: summary (incl. `sync_health`), trends, tools,
  events, hourly, users, demand, gaps.
- `biApi` — HTTP `GET /api/v1/bi/{table}`: key-authenticated flat tables for BI tools (see below).
- `adminAggregate` — HTTP `POST /api/ops/aggregate?from&to` (host key): backfill daily aggregates.
- `canaryProbe` — timer, 01:00 UTC: enqueues one synthetic turn for tenant `queue-probe` so the
  probe key's `health` row proves queue → trigger → table every day (`canary_last_at`).
- `retentionSweep` — timer, Sundays 03:00 UTC: deletes `telemetryevents` rows older than
  `RETENTION_MONTHS` (13). **Dry-run by default**; aborts a real run above `RETENTION_MAX_FRACTION`.

## Digest configuration (Function App settings)

| Setting | Meaning |
|---|---|
| `DIGEST_ENABLED` | `true` to send; anything else = compose-only (inert) |
| `DIGEST_RECIPIENTS` | comma-separated emails (review phase: Maddox only) |
| `DIGEST_FROM` | ACS sender, `DoNotReply@<domain>.azurecomm.net` |
| `ACS_EMAIL_CONNECTION_STRING` | from `az communication list-key -n studioagent-comms` |
| `DIGEST_MIN_SENSITIVE_COUNT` | suppression floor for sensitive topics (default 5) |
| `DIGEST_TENANT_ALLOWLIST` | optional tenant filter; default = all except `unknown` |
| `DASHBOARD_URL` | link base, default `https://www.mystudioagent.ai` |
| `SYNC_STALE_MINUTES` | sync-health stale threshold (default 120) |

Digest content rules live in `src/digest/compose.ts` (pure, unit-tested):
week-over-week deltas, NEW/PERSISTING/closed gap flags, a privacy floor
(counts 1–4 on `conduct_grievance`/`wellbeing` render as "under 5"), and
three honest modes — `normal`, `pre-tagging` (bot build without topic
tagging), `pipeline-dead` (zero events all week sends an alert, not zeros).

Preview before widening recipients:

```
npm run build
node dist/scripts/preview-digest.js            # HTML variants → digest-preview/
node dist/scripts/preview-digest.js --send-test  # one real email (needs env)
```

## ACS infrastructure (provisioned 2026-09-09)

`studioagent-comms` + `studioagent-email` + Azure-managed domain in
`rg-StudioAgent16fddc-dev` (data location UK). Custom from-domain requires a
DNS record — deferred.

## Secrets

`local.settings.json` is untracked (was committed until 2026-09-09 — those
values remain in git history; rotate if this repo is ever shared). Copy
`local.settings.json.example` and fill locally.

## BI API (`/api/v1/bi/*`) — for Epicor Grow and other warehouses

Read-only, key-authenticated, flat-row tables served from `telemetrymetrics`.
Every response is `{ data: [...], next: <url>|null, meta: {...} }`. Rows are
flat (string | number | boolean | null) and carry `row_id` (stable unique key)
and `tenant_id`. All dates are UTC calendar days. Currency is GBP.

| Table | Path | Params | Notes |
|---|---|---|---|
| health | `/api/v1/bi/health` | – | `status` ok / degraded / no_data; pipeline freshness and aggregation currency |
| daily | `/api/v1/bi/daily` | `from`,`to`,`limit`,`cursor` | one row per day; `to` clamps to yesterday; a day with no aggregate row is returned with `aggregation_status: "missing"` and null numbers, never omitted |
| daily (engine verdicts) | same row | – | `outcome_answered/not_covered/retrieval_miss/no_claim_kept/tool_failed/out_of_scope/other`, `outcome_sample_n`, `retrieval_miss_rate`, `not_covered_rate`, `tool_failed_rate`, `total_tokens`, `tool_calls`, `tool_errors`, `claims_kept`, `claims_dropped`, `claims_sample_n`, `build_sha`, `build_shas`. Null until a bot build that enqueues `turn_outcome` is deployed. |
| tool_daily | `/api/v1/bi/tool_daily` | as daily | one row per (day, tool) with executions > 0 |
| topics_daily | `/api/v1/bi/topics_daily` | as daily | one row per (day, topic); coverage joined with outcome; counts 1–4 on `conduct_grievance` / `wellbeing` are suppressed (`suppressed: true`) |
| monthly | `/api/v1/bi/monthly` | `from`,`to` (YYYY-MM), `limit` | hero-metric names and formulas identical to `dashboardApi` summary; current month has `is_complete_month: false` |
| tool_catalog | `/api/v1/bi/tool_catalog` | – | effective baseline, its source, and `baseline_estimated` per tool |

Paging: `limit` 1–1000 (default 500); follow `next` until it is `null`
(Grow: paging "Next Page URL", path `next`; JSON path to data `data`).

### Semantics a consumer must know

- A **conversation** is one `turn_completed` event (one user message with a reply).
- `unique_users` is **not additive**: never SUM daily values; `monthly` carries its own exact count.
- `hours_saved` / `cost_saved` = Σ executions × baseline minutes ÷ 60 × `hourly_rate`, **frozen at
  aggregation** with `baselines_version`. `*_current` columns recompute with today's baselines and
  equal the mystudioagent.ai tiles. A baseline change = new version + backfill + tell the consumer.
- Rates ship with their numerator and denominator on the same row. `error_rate` counts errors only;
  `empty_reply_rate` is separate.
- `answered_ok` = coverage answered AND outcome success. `coverage_unknown` catches values outside
  the frozen enum {answered, deflected, not_in_docs, escalated}.
- Enum values are frozen for v1 (additive only). Breaking changes go to `/api/v2/`.

### Settings

| Setting | Meaning |
|---|---|
| `BI_API_KEYS` | JSON array of **hashed** keys: `[{"id":"allect-k1","sha256":"<hex>","tenant_id":"<uuid>","label":"allect-grow","expires":"2027-01-01"}]`. Unset/invalid → every request 401. |
| `BI_PIPELINE_STALE_HOURS` | hours without any event before `pipeline_ok` is false (default 72) |
| `BI_PUBLIC_BASE_URL` | optional origin used in `next` links (custom domain) |
| `BI_DEADLINE_MS` | internal per-request budget for raw scans (default 20000) |
| `BI_SENSITIVE_FLOOR` | suppression floor for sensitive topics (default 5) |
| `DEFAULT_HOURLY_RATE` | £/hour for cost figures (default 45) |
| `HANDBOOK_BASELINE_MINUTES_JSON` | per-tool baseline override, no redeploy |
| `RETENTION_DRY_RUN` | `false` to actually delete; anything else = count only (default) |
| `RETENTION_MONTHS` | raw-event retention in months (default 13) |
| `RETENTION_MAX_FRACTION` | abort a real sweep that would delete more than this share of rows (default 0.10) |

Mint a key (never paste the key into chat, email or a ticket):

```
KEY=$(openssl rand -hex 32); HASH=$(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1)
# add {"id":"allect-k1","sha256":"$HASH","tenant_id":"<tenant>","label":"allect-grow"} to BI_API_KEYS, then:
az functionapp config appsettings set -g rg-StudioAgent16fddc-dev -n studioagent-telemetry-poster --settings "BI_API_KEYS=$KEYS"
```

The key goes in `Authorization: Bearer <key>` (or `x-api-key`), never in the URL. Rotation: add a
second entry, hand it over, confirm `key_id` switched in the `bi_request` logs, remove the old entry.

### Aggregation and backfill

`dailyAggregation` (02:00 UTC) re-aggregates the trailing 7 days idempotently and writes a zero row
for every known tenant (tenants in `BI_API_KEYS` ∪ tenants already in `telemetrymetrics`), so a
quiet day is distinguishable from a missed run. Longer gaps:

```
HOSTKEY=$(az functionapp keys list -g rg-StudioAgent16fddc-dev -n studioagent-telemetry-poster --query functionKeys.default -o tsv)
curl -sS -X POST "$BASE/api/ops/aggregate?from=2026-06-01&to=2026-08-31&code=$HOSTKEY"   # ≤ 92 days per call
```

Trigger either timer by hand (master key from `az functionapp keys list --query masterKey`):

```
curl -X POST "$BASE/admin/functions/canaryProbe"    -H "x-functions-key: $MASTER" -H "content-type: application/json" -d '{}'
curl -X POST "$BASE/admin/functions/retentionSweep" -H "x-functions-key: $MASTER" -H "content-type: application/json" -d '{}'
```

Grow dashboard definitions: `docs/grow-views.md`.

### Runbook: "the BI tool shows zeros"

1. `GET /api/v1/bi/health` with the consumer's key. 401 → key wrong/expired. 502 → storage.
2. `last_event_at` old → the bot is not emitting: check its `TELEMETRY_QUEUE_NAME=bot-telemetry`, peek
   the queue. Messages piling up → the queue trigger is dead (deployed build, `rgstudioagenttelemetry01_STORAGE`).
3. `last_aggregated_date` < yesterday → timer failed; run the admin backfill.
4. Rows exist but the tool shows zero → it is summing `unique_users`, reading a `missing` row, or its
   JSON path is not `data`.
5. `cost_saved` 0 while `tool_executions` > 0 → `HANDBOOK_BASELINE_MINUTES_JSON` malformed or rate unset;
   check `meta.hourly_rate` and `baselines_version`.
6. Tool rows 0 while turns > 0 → `tool_executed` events landing in the `unknown` partition.

### Data statement (for the client)

The feed provides aggregated usage statistics only: per-day and per-month counts of conversations,
outcomes, response times, topics, and time and cost savings estimated from tool usage and agreed
baselines. No message text, names, user identifiers or per-person records are included; user counts
are computed inside Azure UK South from a salted one-way hash that is never exported. Small counts on
sensitive topics are suppressed in daily views. Figures are computed once per day for the previous UTC
day and do not change unless a baseline revision is announced.
