// adminAggregate.ts — POST /api/ops/aggregate?from=YYYY-MM-DD&to=YYYY-MM-DD
// Re-aggregates a day range into telemetrymetrics (idempotent). Protected by
// the Function App host key (authLevel "function"), so no new auth code.
// Max 92 days per call; call repeatedly for longer gaps.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TableClient } from "@azure/data-tables";
import { aggregateRange, MAX_RANGE_DAYS } from "../aggregation/aggregateDay";
import { baselineForTool, baselinesVersion, hourlyRate } from "../baselines";
import { configuredTenants, parseKeyConfig } from "../bi/auth";
import { BiError, parseDate } from "../bi/query";
import { tableEventsStore, tableMetricsStore } from "../bi/store";
import { addDays, isoDate } from "../bi/util";

const connectionString = process.env.TELEMETRY_QUEUE_CONNECTION_STRING || process.env.AzureWebJobsStorage || "";

export async function adminAggregateHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const started = Date.now();
  const q = new URL(request.url).searchParams;
  try {
    const yesterday = addDays(isoDate(new Date()), -1);
    const to = parseDate(q.get("to"), "to") ?? yesterday;
    const from = parseDate(q.get("from"), "from") ?? to;
    if (from > to) throw new BiError(400, "invalid_param", "from must not be after to", "from");
    if (to > yesterday) throw new BiError(400, "invalid_param", "to must be yesterday or earlier (today is incomplete)", "to");

    const events = tableEventsStore(TableClient.fromConnectionString(connectionString, "telemetryevents"));
    const metrics = tableMetricsStore(TableClient.fromConnectionString(connectionString, "telemetrymetrics"));
    const known = new Set<string>([...configuredTenants(parseKeyConfig(process.env.BI_API_KEYS)), ...(await metrics.tenants())]);
    known.delete("unknown");
    const rate = hourlyRate();

    const result = await aggregateRange(from, to, {
      scanEvents: (ge, le) => events.scanEvents(ge, le),
      upsertMetrics: (e) => metrics.upsert(e),
      knownTenants: Array.from(known),
      rate,
      baselineFn: (t) => baselineForTool(t).minutes,
      baselineEstimatedFn: (t) => baselineForTool(t).estimated,
      baselinesVersion: baselinesVersion({ rate }),
      log: (m) => context.log(m),
    });
    return {
      status: 200,
      jsonBody: { from, to, days: result.days, tenants_written: result.tenantsWritten, max_days_per_call: MAX_RANGE_DAYS, ms: Date.now() - started },
    };
  } catch (err: any) {
    if (err instanceof BiError) return { status: err.status, jsonBody: { error: { code: err.code, message: err.message, param: err.param } } };
    if (/range too large/.test(String(err?.message))) return { status: 400, jsonBody: { error: { code: "invalid_param", message: err.message } } };
    context.error("[AdminAggregate] error:", err);
    return { status: 500, jsonBody: { error: { code: "internal", message: "internal error" } } };
  }
}

app.http("adminAggregate", {
  methods: ["POST"],
  authLevel: "function",
  route: "ops/aggregate",
  handler: adminAggregateHandler,
});
