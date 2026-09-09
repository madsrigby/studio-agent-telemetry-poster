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
