// biApi.ts — GET /api/v1/bi/{table}. Glue only: auth → table → cache →
// handler → structured log. All logic lives in src/bi/*.
//
// Settings: BI_API_KEYS (JSON array of hashed keys, see src/bi/auth.ts),
// BI_PIPELINE_STALE_HOURS (default 72), BI_PUBLIC_BASE_URL (optional),
// BI_DEADLINE_MS (default 20000), BI_SENSITIVE_FLOOR (default 5).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TableClient } from "@azure/data-tables";
import { authenticate, parseKeyConfig, type KeyEntry } from "../bi/auth";
import { TtlCache } from "../bi/cache";
import { type BiContext, DEFAULT_STALE_HOURS, type Envelope, handleTable } from "../bi/handlers";
import { BiError, TABLES, canonicalQuery, isTable } from "../bi/query";
import { tableEventsStore, tableMetricsStore, type EventsStore, type MetricsStore } from "../bi/store";
import { baselineForTool, baselinesVersion, categoryWithSource, hourlyRate } from "../baselines";
import { DEFAULT_SENSITIVE_FLOOR } from "../bi/rows";

const connectionString = process.env.TELEMETRY_QUEUE_CONNECTION_STRING || process.env.AzureWebJobsStorage || "";

let stores: { metrics: MetricsStore; events: EventsStore } | null = null;
function getStores(): { metrics: MetricsStore; events: EventsStore } {
  if (!stores) {
    stores = {
      metrics: tableMetricsStore(TableClient.fromConnectionString(connectionString, "telemetrymetrics")),
      events: tableEventsStore(TableClient.fromConnectionString(connectionString, "telemetryevents")),
    };
  }
  return stores;
}

let keyConfigRaw: string | undefined;
let keyConfig: KeyEntry[] = [];
function getKeyConfig(): KeyEntry[] {
  const raw = process.env.BI_API_KEYS;
  if (raw !== keyConfigRaw) {
    keyConfigRaw = raw;
    keyConfig = parseKeyConfig(raw);
  }
  return keyConfig;
}

const cache = new TtlCache<Envelope>(60_000, 200);

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "private, max-age=60" };

function errorBody(status: number, code: string, message: string, requestId: string, param?: string): HttpResponseInit {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (status === 401) headers["www-authenticate"] = "Bearer";
  return { status, headers, jsonBody: { error: { code, message, ...(param ? { param } : {}), request_id: requestId } } };
}

function intSetting(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function biHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const started = Date.now();
  const requestId = context.invocationId;
  const table = String(request.params.table || "");
  const q = new URL(request.url).searchParams;

  const auth = authenticate(request.headers, getKeyConfig());
  if (auth.ok === false) {
    if (auth.reason === "no_config") context.error("[BI] BI_API_KEYS missing or invalid — every request is refused");
    context.log(JSON.stringify({ evt: "bi_request", table, status: 401, reason: auth.reason, ms: Date.now() - started }));
    return errorBody(401, "unauthorized", "a valid API key is required", requestId);
  }

  if (!isTable(table)) {
    return { ...errorBody(404, "unknown_table", `unknown table "${table}"`, requestId), jsonBody: { error: { code: "unknown_table", message: `unknown table "${table}"`, available: TABLES, request_id: requestId } } };
  }

  const warnings: string[] = [];
  if (q.has("tenant_id")) {
    warnings.push("tenant_id query parameter is ignored; the tenant is bound to the API key");
    q.delete("tenant_id");
  }

  const cacheKey = `${auth.tenantId}|${table}|${canonicalQuery(q)}`;
  const hit = cache.get(cacheKey);
  if (hit) {
    const body = { ...hit.value, meta: { ...hit.value.meta, cached: true, cache_age_s: Math.round(hit.ageMs / 1000) } };
    context.log(JSON.stringify({ evt: "bi_request", key_id: auth.keyId, tenant_id: auth.tenantId, table, status: 200, rows: body.data.length, ms: Date.now() - started, cached: true }));
    return { status: 200, headers: JSON_HEADERS, jsonBody: body };
  }

  const s = getStores();
  const rate = hourlyRate();
  const ctx: BiContext = {
    tenantId: auth.tenantId,
    keyId: auth.keyId,
    label: auth.label,
    metrics: s.metrics,
    events: s.events,
    now: new Date(),
    rate,
    baselinesVersion: baselinesVersion({ rate }),
    baselineFn: (tool) => baselineForTool(tool),
    categoryFn: (tool) => categoryWithSource(tool),
    deadlineMs: intSetting("BI_DEADLINE_MS", 20_000),
    requestUrl: request.url,
    publicBase: process.env.BI_PUBLIC_BASE_URL || undefined,
    requestId,
    staleHours: intSetting("BI_PIPELINE_STALE_HOURS", DEFAULT_STALE_HOURS),
    sensitiveFloor: intSetting("BI_SENSITIVE_FLOOR", DEFAULT_SENSITIVE_FLOOR),
  };

  try {
    const env = await handleTable(table, q, ctx);
    const metaWarnings = Array.isArray(env.meta.warnings) ? (env.meta.warnings as string[]) : [];
    env.meta.warnings = [...warnings, ...metaWarnings];
    cache.set(cacheKey, env);
    context.log(JSON.stringify({ evt: "bi_request", key_id: auth.keyId, tenant_id: auth.tenantId, table, from: env.meta.from, to: env.meta.to, limit: env.meta.limit, status: 200, rows: env.data.length, ms: Date.now() - started, cached: false }));
    return { status: 200, headers: JSON_HEADERS, jsonBody: env };
  } catch (err: any) {
    if (err instanceof BiError) {
      context.log(JSON.stringify({ evt: "bi_request", key_id: auth.keyId, tenant_id: auth.tenantId, table, status: err.status, code: err.code, ms: Date.now() - started }));
      return errorBody(err.status, err.code, err.message, requestId, err.param);
    }
    const storage = typeof err?.statusCode === "number" || err?.name === "RestError";
    context.error(`[BI] ${storage ? "storage" : "internal"} error on ${table}: ${err?.message || err}`, err?.stack);
    context.log(JSON.stringify({ evt: "bi_request", key_id: auth.keyId, tenant_id: auth.tenantId, table, status: storage ? 502 : 500, ms: Date.now() - started }));
    return storage
      ? errorBody(502, "storage_unavailable", "telemetry storage did not respond", requestId)
      : errorBody(500, "internal", "internal error", requestId);
  }
}

app.http("biApi", {
  methods: ["GET"],
  authLevel: "anonymous", // our own key check; see src/bi/auth.ts
  route: "v1/bi/{table}",
  handler: biHandler,
});
