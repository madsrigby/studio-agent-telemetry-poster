# Grow views for the Studio Agent feed

Four views, one sitting. Every table below is a Custom REST API table in Grow
(see the README "BI API" section for the connector settings). All dates are UTC.

Two rules that apply everywhere:

1. **Never SUM `unique_users` across days.** Use the Monthly table's value.
2. **Filter Daily on `aggregation_status = 'complete'`.** A `missing` row means the nightly
   aggregation has not run for that day; its numbers are null, not zero.

## 1. Adoption — "are people using it?"

Table: Daily (`/api/v1/bi/daily`), Monthly (`/api/v1/bi/monthly`).

| Tile / chart | Column(s) | Note |
|---|---|---|
| Conversations this month | Monthly `total_conversations` | current month row has `is_complete_month = false` |
| Substantive conversations | Daily `turns_substantive` (sum) | excludes greetings served from the instant-reply cache |
| Active people this month | Monthly `unique_users` | exact; do not derive from Daily |
| Conversations per day | Daily `turns` by `date` | line chart |
| Employee vs admin bot | Daily `employee_turns`, `admin_turns` | stacked bar |

## 2. Reliability — "is it working?"

Table: Daily, Pipeline health (`/api/v1/bi/health`).

| Tile / chart | Column(s) | Threshold to colour red |
|---|---|---|
| Success rate | Daily `success_count` / `turns` (weighted) | below 0.97 |
| Empty replies | Daily `empty_reply_count` | any |
| Errors | Daily `error_count` | any |
| Response time, typical | Daily `avg_latency_ms`, weighted by `latency_sample_n` | above 4000 |
| Response time, worst 5% | Daily `p95_latency_ms` (show max, never average) | above 8000 |
| Pipeline status | Health `status`, `pipeline_ok`, `aggregation_ok`, `last_event_at` | anything but `ok` |

Compute rates from the counts on the same row. Do not average `success_rate` across days.

## 3. Demand — "what do people ask about?"

Table: Topics by day (`/api/v1/bi/topics_daily`).

| Tile / chart | Column(s) | Note |
|---|---|---|
| Questions by theme | `turns` by `topic` (sum over period) | bar, sorted |
| Answered well | `answered_ok` | answered AND the reply succeeded |
| Theme trend | `turns` by `date`, series `topic` | line |

Rows with `suppressed = true` (grievance, wellbeing with fewer than 5 questions that day) have
null counts by design. Show them as "under 5".

## 4. Gaps and ROI — "what should we fix, and what is it worth?"

Tables: Topics by day, Tools by day (`/api/v1/bi/tool_daily`), Tool catalog (`/api/v1/bi/tool_catalog`).

| Tile / chart | Column(s) | Note |
|---|---|---|
| Not in the documents | Topics `not_in_docs` by `topic` | the content-gap list; each bar is a document to add |
| Deflected to HR | Topics `deflected` by `topic` | questions the assistant must not answer by policy |
| Unknown coverage | Topics `coverage_unknown` | should stay at zero; non-zero means a bot build drifted |
| Hours saved | Tools `hours_saved` (sum) | frozen at aggregation; `baselines_version` on Daily |
| Cost saved (GBP) | Tools `cost_saved` (sum), `hourly_rate` | |
| Provisional figures | Catalog `baseline_estimated = true` | join to Tools on `tool` to flag provisional rows |
| Top tools | Tools `executions` by `tool` | |

If a figure changes after a baseline revision, `baselines_version` on Daily changes with it. Ask
for a full refresh of the Daily and Tools tables in Grow when that happens.
