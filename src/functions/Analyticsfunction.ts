// analyticsFunction.ts — FULL REPLACEMENT (v3 — with all 4 bug fixes + tool_counts)
// Goes in: src/functions/ (next to postTelemetryToRelevance.ts)
//
// CHANGELOG:
//   v1: Original 6-endpoint analytics function
//   v2: Added tool_counts to trends endpoint for Tool Deep Dive expanded rows
//   v3: Four bug fixes:
//     FIX 1: Store correlationId as queryable table column (events endpoint was silently returning empty)
//     FIX 2: Accurate monthly unique users by scanning raw events (was overcounting by summing daily uniques)
//     FIX 3: trends.days explicitly sorted ascending by date (chart consistency)
//     FIX 4: has_turn_data flag in summary response (Page 4 can reliably show EmptyState vs real zeros)
//
// 3 triggers:
//   1. HTTP webhook — receives tool_executed/turn_completed events
//   2. Timer — daily metrics aggregation at 02:00 UTC
//   3. HTTP — dashboard API: summary, trends, tools, events, hourly, users

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TableClient } from "@azure/data-tables";
import { catalogCategory, catalogBaselineMinutes } from "../toolCatalog";

// ── Table Storage Setup ──────────────────────────────────────────────────────

const connectionString =
  process.env.TELEMETRY_QUEUE_CONNECTION_STRING ||
  process.env.AzureWebJobsStorage ||
  "";

const eventsTable = TableClient.fromConnectionString(connectionString, "telemetryevents");
const metricsTable = TableClient.fromConnectionString(connectionString, "telemetrymetrics");
const insightTable = TableClient.fromConnectionString(connectionString, "weeklyinsight");

let tablesReady = false;
async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  await eventsTable.createTable().catch(() => {});
  await metricsTable.createTable().catch(() => {});
  await insightTable.createTable().catch(() => {});
  tablesReady = true;
}

// ── Safe JSON parse helper ────────────────────────────────────────────────────
// Prevents endpoint crashes if a payload row contains malformed JSON.

function safeJsonParse(value: string | undefined | null, fallback: any = {}): any {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

// ── Shared: write event to Table Storage ─────────────────────────────────────

export async function writeEventToTable(event: any, context: InvocationContext): Promise<void> {
  await ensureTables();

  const tenantId = event.tenant_id || "unknown";
  const ts = event.timestamp || new Date().toISOString();
  const id = event.correlation_id || event.tool_name || Math.random().toString(36).slice(2, 10);
  const eventType = event.event_type || "unknown";

  const invertedTs = String(9999999999999 - new Date(ts).getTime()).padStart(13, "0");

  const entity: any = {
    partitionKey: tenantId,
    rowKey: `${invertedTs}_${eventType}_${id}`,
    eventType,
    timestamp: ts,
    payload: JSON.stringify(event),
  };

  // ── FIX 1: Store correlationId as a queryable table column ──
  // The events endpoint filters on `correlationId` as a column property.
  // Without this stored as a column, that filter silently returns zero results.
  if (event.correlation_id) {
    entity.correlationId = event.correlation_id;
  }

  if (eventType === "tool_executed") {
    entity.toolName = event.tool_name || "";
    entity.toolCategory = event.tool_category || "";
    entity.success = event.success ?? true;
  }

  if (eventType === "turn_completed") {
    entity.userHash = event.user_hash || "";
    entity.agentType = event.agent_type || "";
    // HR Demand Intelligence — queryable columns for the demand/gaps endpoints.
    if (event.answer_coverage) entity.answerCoverage = event.answer_coverage;
    if (event.topic) entity.topic = event.topic;
  }

  // Sync-health tile: store the adjustment-sync outcome as queryable columns.
  if (eventType === "adjustment_sync") {
    entity.outcome = event.outcome || "";
    entity.rows = event.rows ?? 0;
    entity.durationMs = event.duration_ms ?? 0;
  }

  if (eventType === "escalation") {
    entity.kind = event.kind || "";
  }

  try {
    await eventsTable.createEntity(entity);
    context.log(`[Analytics] Stored ${eventType}: ${entity.rowKey}`);
  } catch (err: any) {
    if (err.statusCode === 409) {
      context.log(`[Analytics] Duplicate skipped: ${entity.rowKey}`);
    } else {
      throw err;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TRIGGER 1: HTTP Webhook — receives tool_executed events from Relevance tools
// ══════════════════════════════════════════════════════════════════════════════

async function webhookHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Health check
  if (request.method === "GET") {
    return { status: 200, jsonBody: { status: "ok", service: "hr-agent-analytics", timestamp: new Date().toISOString() } };
  }

  // Auth check
  const expectedKey = process.env.POSTER_WEBHOOK_API_KEY;
  if (expectedKey) {
    const providedKey = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace("Bearer ", "");
    if (providedKey !== expectedKey) {
      return { status: 401, jsonBody: { error: "Unauthorized" } };
    }
  }

  try {
    const body = await request.json() as any;

    if (!body.event_type) {
      return { status: 400, jsonBody: { error: "Missing event_type" } };
    }

    if (!["turn_completed", "tool_executed", "adjustment_sync", "escalation"].includes(body.event_type)) {
      return { status: 400, jsonBody: { error: `Unknown event_type: ${body.event_type}` } };
    }

    await writeEventToTable(body, context);

    return { status: 200, jsonBody: { status: "accepted", event_type: body.event_type } };
  } catch (err: any) {
    context.error("[Analytics] Webhook error:", err);
    return { status: 500, jsonBody: { error: "Internal server error" } };
  }
}

app.http("analyticsWebhook", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "telemetry/ingest",
  handler: webhookHandler,
});

// ══════════════════════════════════════════════════════════════════════════════
// TRIGGER 2: Timer — daily metrics aggregation
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_BASELINE_MINUTES: Record<string, number> = {
  get_my_employee_details: 3, create_my_leave_request: 5, list_my_absences: 3,
  list_my_bonuses: 4, list_departments: 2, list_divisions: 2, list_locations: 2,
  list_working_patterns: 2, list_employees: 3, get_employee_details: 3,
  create_employee: 15, create_employee_change_request: 7, list_change_requests: 3,
  approve_change_request: 5, list_leave_requests: 3, get_leave_request: 3,
  create_leave_request: 5, approve_leave_request: 3, reject_leave_request: 5,
  list_absences: 3, cancel_absence: 5, list_all_bonuses: 3,
  list_employee_bonuses: 3, get_company_account_details: 3, list_holiday_allowances: 3,
  resolve_employee_id: 1, list_my_sicknesses: 3, list_sicknesses: 3,
  update_sickness: 5, approve_leave_request_admin: 3, reject_leave_request_admin: 5,
  create_leave_request_admin: 5, get_leave_request_admin: 3, list_leave_requests_admin: 3,
};

function getHandbookBaselines(): Record<string, number> {
  try {
    const raw = process.env.HANDBOOK_BASELINE_MINUTES_JSON;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) clean[k] = n;
    }
    return clean;
  } catch {
    return {};
  }
}

const HANDBOOK_BASELINES = getHandbookBaselines();

function baselineMinutesForTool(toolName: string): number {
  // Precedence: env override > vendored bot catalog > legacy map (pre-rename
  // tool names still present in historical events) > 3-minute floor.
  return HANDBOOK_BASELINES[toolName]
    || catalogBaselineMinutes(toolName)
    || DEFAULT_BASELINE_MINUTES[toolName]
    || 3;
}

function categoryForTool(toolName: string): string {
  // Catalog first (the bot owns the contract); prefix heuristic only for
  // legacy names the catalog does not know.
  return catalogCategory(toolName)
    || (toolName.startsWith("create") || toolName.startsWith("update") || toolName.startsWith("cancel") ? "write"
      : toolName.startsWith("approve") || toolName.startsWith("reject") ? "policy"
      : toolName.startsWith("resolve") ? "resolver"
      : "read");
}

async function dailyAggregation(_timer: unknown, context: InvocationContext): Promise<void> {
  context.log("[Aggregation] Starting daily metrics");
  await ensureTables();

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  const dayStart = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  const dayEnd = new Date(`${dateStr}T23:59:59.999Z`).getTime();
  const invertedEnd = String(9999999999999 - dayStart).padStart(13, "0");
  const invertedStart = String(9999999999999 - dayEnd).padStart(13, "0");

  const hourlyRate = parseFloat(process.env.DEFAULT_HOURLY_RATE || "45");

  const tenantData: Record<string, { turns: any[]; toolExecs: any[]; users: Set<string> }> = {};

  try {
    const entities = eventsTable.listEntities({
      queryOptions: { filter: `RowKey ge '${invertedStart}' and RowKey le '${invertedEnd}'` },
    });

    for await (const entity of entities) {
      const tenantId = entity.partitionKey as string;
      if (!tenantData[tenantId]) {
        tenantData[tenantId] = { turns: [], toolExecs: [], users: new Set() };
      }
      const payload = safeJsonParse(entity.payload as string);

      if (entity.eventType === "turn_completed") {
        tenantData[tenantId].turns.push(payload);
        if (payload.user_hash) tenantData[tenantId].users.add(payload.user_hash);
      } else if (entity.eventType === "tool_executed") {
        tenantData[tenantId].toolExecs.push(payload);
      }
    }

    for (const [tenantId, data] of Object.entries(tenantData)) {
      const { turns, toolExecs, users } = data;

      const successCount = turns.filter(t => t.outcome === "success").length;
      const errorCount = turns.filter(t => t.outcome === "error").length;
      const emptyCount = turns.filter(t => t.outcome === "empty_reply").length;

      const latencies = turns.map(t => t.latency_total_ms).filter(l => typeof l === "number").sort((a, b) => a - b);
      const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
      const p95Latency = latencies.length > 0 ? latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] : 0;

      const toolCounts: Record<string, number> = {};
      for (const exec of toolExecs) {
        const name = exec.tool_name || "unknown";
        toolCounts[name] = (toolCounts[name] || 0) + 1;
      }

      let totalBaselineMinutes = 0;
      for (const exec of toolExecs) {
        const toolName = exec.tool_name || "unknown";
        // Supports explicit per-event estimate from handbook instrumentation, else falls back.
        const manualMinutes = Number(exec.estimated_manual_minutes);
        const baseline = Number.isFinite(manualMinutes) && manualMinutes > 0
          ? manualMinutes
          : baselineMinutesForTool(toolName);
        totalBaselineMinutes += baseline;
      }

      const hoursSaved = totalBaselineMinutes / 60;
      const costSaved = hoursSaved * hourlyRate;

      await metricsTable.upsertEntity({
        partitionKey: tenantId,
        rowKey: dateStr,
        computedAt: new Date().toISOString(),
        totalTurns: turns.length,
        totalToolExecutions: toolExecs.length,
        uniqueUsers: users.size,
        successCount, errorCount, emptyReplyCount: emptyCount,
        successRate: turns.length > 0 ? successCount / turns.length : 0,
        avgLatencyMs: Math.round(avgLatency),
        p95LatencyMs: Math.round(p95Latency),
        employeeTurns: turns.filter(t => t.agent_type === "employee").length,
        adminTurns: turns.filter(t => t.agent_type === "admin").length,
        toolCounts: JSON.stringify(toolCounts),
        totalBaselineMinutes,
        hoursSaved: Math.round(hoursSaved * 100) / 100,
        costSaved: Math.round(costSaved * 100) / 100,
        hourlyRate,
      }, "Replace");

      context.log(`[Aggregation] ${tenantId} ${dateStr}: ${turns.length} turns, ${toolExecs.length} tools, £${costSaved.toFixed(2)} saved`);
    }
  } catch (err) {
    context.error("[Aggregation] Error:", err);
    throw err;
  }
}

app.timer("dailyAggregation", {
  schedule: "0 0 2 * * *",
  handler: dailyAggregation,
});

// ══════════════════════════════════════════════════════════════════════════════
// TRIGGER 2b: Timer — weekly HR demand insight digest (Mondays 06:00 UTC)
// ══════════════════════════════════════════════════════════════════════════════
// Composes the week's demand-by-topic and top content gaps per tenant and
// stores the digest in the `weeklyinsight` table. This repo has no mail sender
// (no SendGrid, no action-group hook), so SENDING is a follow-up: read the
// newest row per tenant and mail it, or wire an action group to this table.

async function weeklyInsight(_timer: unknown, context: InvocationContext): Promise<void> {
  context.log("[WeeklyInsight] Composing weekly HR demand digest");
  await ensureTables();

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const invertedStart = String(9999999999999 - now).padStart(13, "0");
  const invertedEnd = String(9999999999999 - weekAgo).padStart(13, "0");
  const weekEnd = new Date(now).toISOString().split("T")[0];

  type TopicCounts = Record<string, { total: number; answered: number; deflected: number; not_in_docs: number; escalated: number }>;
  const perTenant: Record<string, { byTopic: TopicCounts; tagged: number; untagged: number; escalations: Record<string, number> }> = {};

  try {
    const entities = eventsTable.listEntities({
      queryOptions: { filter: `RowKey ge '${invertedStart}' and RowKey le '${invertedEnd}'` },
    });

    for await (const entity of entities) {
      const p = safeJsonParse(entity.payload as string);
      const tenantId = (p.tenant_id as string) || (entity.partitionKey as string) || "unknown";
      if (!perTenant[tenantId]) perTenant[tenantId] = { byTopic: {}, tagged: 0, untagged: 0, escalations: {} };
      const t = perTenant[tenantId];

      if (entity.eventType === "turn_completed") {
        if (!p.answer_coverage && !p.topic) { t.untagged++; continue; }
        t.tagged++;
        const topic = p.topic || "other";
        if (!t.byTopic[topic]) t.byTopic[topic] = { total: 0, answered: 0, deflected: 0, not_in_docs: 0, escalated: 0 };
        t.byTopic[topic].total++;
        const cov = p.answer_coverage as string;
        if (cov === "answered" || cov === "deflected" || cov === "not_in_docs" || cov === "escalated") {
          (t.byTopic[topic] as any)[cov]++;
        }
      } else if (entity.eventType === "escalation") {
        const kind = p.kind || "unknown";
        t.escalations[kind] = (t.escalations[kind] || 0) + 1;
      }
    }

    for (const [tenantId, t] of Object.entries(perTenant)) {
      if (tenantId === "unknown" && t.tagged === 0 && Object.keys(t.escalations).length === 0) continue;

      const topTopics = Object.entries(t.byTopic)
        .map(([topic, c]) => ({ topic, ...c }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);
      const topGaps = Object.entries(t.byTopic)
        .map(([topic, c]) => ({ topic, unanswered: c.deflected + c.not_in_docs, not_in_docs: c.not_in_docs, deflected: c.deflected }))
        .filter(g => g.unanswered > 0)
        .sort((a, b) => b.unanswered - a.unanswered)
        .slice(0, 5);

      await insightTable.upsertEntity({
        partitionKey: tenantId,
        rowKey: weekEnd,
        computedAt: new Date().toISOString(),
        taggedTurns: t.tagged,
        untaggedTurns: t.untagged,
        topTopics: JSON.stringify(topTopics),
        topGaps: JSON.stringify(topGaps),
        escalationsByKind: JSON.stringify(t.escalations),
        sent: false, // flips when a sender is wired
      }, "Replace");

      context.log(`[WeeklyInsight] ${tenantId} week-to-${weekEnd}: ${t.tagged} tagged turns, ${topGaps.length} gap topics`);
    }
  } catch (err) {
    context.error("[WeeklyInsight] Error:", err);
    throw err;
  }
}

app.timer("weeklyInsight", {
  schedule: "0 0 6 * * 1",
  handler: weeklyInsight,
});

// ══════════════════════════════════════════════════════════════════════════════
// TRIGGER 3: HTTP — Dashboard API (6 endpoints)
// ══════════════════════════════════════════════════════════════════════════════

// ── Sync health (adjustment-sync tile) ───────────────────────────────────────
// adjustment_sync events carry NO tenant_id (they come from a background job,
// not a user turn), so they land in the "unknown" partition. Query by eventType
// across partitions, bounded to the last 7 days via the inverted-timestamp
// RowKey (recent events have SMALLER row keys).
async function computeSyncHealth(context: InvocationContext): Promise<any> {
  const staleMinutes = parseInt(process.env.SYNC_STALE_MINUTES || "120", 10);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const invertedBound = String(9999999999999 - sevenDaysAgo).padStart(13, "0");

  let lastRun: any = null;      // newest event of any outcome
  let lastSuccess: any = null;  // newest success

  try {
    const entities = eventsTable.listEntities({
      queryOptions: { filter: `RowKey le '${invertedBound}' and eventType eq 'adjustment_sync'` },
    });
    for await (const entity of entities) {
      const p = safeJsonParse(entity.payload as string);
      if (!p.timestamp) continue;
      if (!lastRun || p.timestamp > lastRun.timestamp) lastRun = p;
      if (p.outcome === "success" && (!lastSuccess || p.timestamp > lastSuccess.timestamp)) lastSuccess = p;
    }
  } catch (err) {
    context.log("[Dashboard] sync-health scan failed");
  }

  if (!lastRun) {
    return { has_data: false, stale: true, last_run: null, last_success: null };
  }

  const ageMinutes = lastSuccess
    ? Math.round((Date.now() - new Date(lastSuccess.timestamp).getTime()) / 60000)
    : null;

  return {
    has_data: true,
    last_run: lastRun.timestamp,
    last_outcome: lastRun.outcome,
    last_reason: lastRun.reason || "",
    last_rows: lastRun.rows ?? 0,
    last_duration_ms: lastRun.duration_ms ?? 0,
    last_success: lastSuccess ? lastSuccess.timestamp : null,
    last_success_rows: lastSuccess ? lastSuccess.rows ?? 0 : 0,
    age_minutes: ageMinutes,
    stale: ageMinutes === null || ageMinutes > staleMinutes,
    stale_threshold_minutes: staleMinutes,
  };
}

// ── Demand / gaps aggregation over turn_completed events ─────────────────────
// answer_coverage + topic are metadata-only fields on the turn envelope
// (never message text). Turns from bot builds that predate the fields count
// as "untagged" so the pages can show data coverage honestly.
async function aggregateTurnTopics(tenantId: string, targetMonth: string): Promise<{
  byTopic: Record<string, { total: number; answered: number; deflected: number; not_in_docs: number; escalated: number }>;
  taggedTurns: number;
  untaggedTurns: number;
}> {
  const byTopic: Record<string, { total: number; answered: number; deflected: number; not_in_docs: number; escalated: number }> = {};
  let taggedTurns = 0;
  let untaggedTurns = 0;

  const entities = eventsTable.listEntities({
    queryOptions: { filter: `PartitionKey eq '${tenantId}' and eventType eq 'turn_completed'` },
  });
  for await (const entity of entities) {
    const p = safeJsonParse(entity.payload as string);
    const ts = p.timestamp;
    if (!ts || !ts.startsWith(targetMonth)) continue;

    if (!p.answer_coverage && !p.topic) { untaggedTurns++; continue; }
    taggedTurns++;

    const topic = p.topic || "other";
    if (!byTopic[topic]) byTopic[topic] = { total: 0, answered: 0, deflected: 0, not_in_docs: 0, escalated: 0 };
    byTopic[topic].total++;
    const cov = p.answer_coverage as string;
    if (cov === "answered" || cov === "deflected" || cov === "not_in_docs" || cov === "escalated") {
      byTopic[topic][cov]++;
    }
  }

  return { byTopic, taggedTurns, untaggedTurns };
}

async function dashboardHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  await ensureTables();

  const tenantId = request.query.get("tenant_id");
  if (!tenantId) return { status: 400, jsonBody: { error: "tenant_id required" } };

  const endpoint = request.query.get("endpoint") || "summary";
  const period = request.query.get("period");
  const from = request.query.get("from");
  const to = request.query.get("to");

  try {
    // ── ENDPOINT 1: summary ────────────────────────────────────────────────
    if (endpoint === "summary") {
      const targetMonth = period || new Date().toISOString().slice(0, 7);
      const entities = metricsTable.listEntities({
        queryOptions: { filter: `PartitionKey eq '${tenantId}' and RowKey ge '${targetMonth}-01' and RowKey le '${targetMonth}-31'` },
      });

      let totalTurns = 0, totalToolExecs = 0, totalCostSaved = 0, totalHoursSaved = 0;
      let successTotal = 0, turnTotal = 0;
      let avgLatencySum = 0, latencyDays = 0;
      let p95Max = 0;
      let employeeTurns = 0, adminTurns = 0;
      const allToolCounts: Record<string, number> = {};

      for await (const entity of entities) {
        totalTurns += (entity.totalTurns as number) || 0;
        totalToolExecs += (entity.totalToolExecutions as number) || 0;
        totalCostSaved += (entity.costSaved as number) || 0;
        totalHoursSaved += (entity.hoursSaved as number) || 0;
        successTotal += (entity.successCount as number) || 0;
        turnTotal += (entity.totalTurns as number) || 0;
        employeeTurns += (entity.employeeTurns as number) || 0;
        adminTurns += (entity.adminTurns as number) || 0;
        const avgLat = (entity.avgLatencyMs as number) || 0;
        if (avgLat > 0) { avgLatencySum += avgLat; latencyDays++; }
        const p95 = (entity.p95LatencyMs as number) || 0;
        if (p95 > p95Max) p95Max = p95;
        const tc = safeJsonParse(entity.toolCounts as string);
        for (const [tool, count] of Object.entries(tc)) {
          allToolCounts[tool] = (allToolCounts[tool] || 0) + (count as number);
        }
      }

      // ── FIX 2: Accurate monthly unique users ──
      // Summing daily unique_users overcounts (same user active on Monday + Tuesday = counted twice).
      // Instead, scan raw events for the month and deduplicate by user_hash.
      // NOTE: At scale (10k+ events/month), move this to a pre-aggregated monthly unique count
      // computed by the timer function.
      const monthUniqueUsers = new Set<string>();
      let hasTurnData = false;

      try {
        const rawEntities = eventsTable.listEntities({
          queryOptions: { filter: `PartitionKey eq '${tenantId}'` },
        });
        for await (const rawEntity of rawEntities) {
          const payload = safeJsonParse(rawEntity.payload as string);
          const ts = payload.timestamp;
          if (!ts || !ts.startsWith(targetMonth)) continue;

          if (payload.user_hash) {
            monthUniqueUsers.add(payload.user_hash);
          }
          // ── FIX 4: Detect whether any turn_completed events exist ──
          if (payload.event_type === "turn_completed") {
            hasTurnData = true;
          }
        }
      } catch (err) {
        // If the raw scan fails, log it but don't crash the endpoint
        context.log("[Dashboard] Unique user scan failed, unique_users may be approximate");
      }

      // Recompute month savings from tool counts + current handbook baselines + current hourly rate.
      // This avoids stale historical aggregates when assumptions (rate/baselines) are updated.
      const hourlyRate = parseFloat(process.env.DEFAULT_HOURLY_RATE || "45");
      let recomputedTotalBaselineMinutes = 0;
      for (const [toolName, count] of Object.entries(allToolCounts)) {
        recomputedTotalBaselineMinutes += (count as number) * baselineMinutesForTool(toolName);
      }
      const recomputedHoursSaved = recomputedTotalBaselineMinutes / 60;
      const recomputedCostSaved = recomputedHoursSaved * hourlyRate;

      const syncHealth = await computeSyncHealth(context);

      return {
        status: 200,
        jsonBody: {
          tenant_id: tenantId,
          period: targetMonth,
          sync_health: syncHealth,
          // ── FIX 4: Readiness flag for frontend ──
          // When false, Page 4 (Performance) shows EmptyState instead of misleading zeros.
          // When true, at least one turn_completed event exists — zeros are real zeros.
          has_turn_data: hasTurnData,
          hero_metrics: {
            cost_saved: Math.round(recomputedCostSaved * 100) / 100,
            hours_saved: Math.round(recomputedHoursSaved * 100) / 100,
            self_service_rate: turnTotal > 0 ? Math.round((successTotal / turnTotal) * 10000) / 100 : 0,
            total_conversations: totalTurns,
            total_tool_executions: totalToolExecs,
            unique_users: monthUniqueUsers.size > 0 ? monthUniqueUsers.size : 0,  // ← FIX 2: true monthly uniques
            avg_latency_ms: latencyDays > 0 ? Math.round(avgLatencySum / latencyDays) : 0,
            p95_latency_ms: p95Max,
            error_rate: turnTotal > 0 ? Math.round(((turnTotal - successTotal) / turnTotal) * 10000) / 100 : 0,
            employee_turns: employeeTurns,
            admin_turns: adminTurns,
            projected_annual_savings: Math.round(recomputedCostSaved * 12 * 100) / 100,
            projected_annual_hours: Math.round(recomputedHoursSaved * 12 * 100) / 100,
          },
          top_tools: Object.entries(allToolCounts)
            .sort(([, a], [, b]) => (b as number) - (a as number))
            .slice(0, 10)
            .map(([name, count]) => ({ tool: name, count })),
        },
      };
    }

    // ── ENDPOINT 2: trends ─────────────────────────────────────────────────
    if (endpoint === "trends") {
      const startDate = from || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split("T")[0]; })();
      const endDate = to || new Date().toISOString().split("T")[0];
      const entities = metricsTable.listEntities({
        queryOptions: { filter: `PartitionKey eq '${tenantId}' and RowKey ge '${startDate}' and RowKey le '${endDate}'` },
      });
      const days: any[] = [];
      for await (const entity of entities) {
        days.push({
          date: entity.rowKey,
          total_turns: entity.totalTurns,
          tool_executions: entity.totalToolExecutions,
          unique_users: entity.uniqueUsers,
          success_rate: entity.successRate,
          avg_latency_ms: entity.avgLatencyMs,
          p95_latency_ms: entity.p95LatencyMs,
          hours_saved: entity.hoursSaved,
          cost_saved: entity.costSaved,
          employee_turns: entity.employeeTurns,
          admin_turns: entity.adminTurns,
          success_count: entity.successCount,
          error_count: entity.errorCount,
          empty_reply_count: entity.emptyReplyCount,
          tool_counts: safeJsonParse(entity.toolCounts as string),  // v2: per-tool daily counts for Tool Deep Dive
        });
      }

      // ── FIX 3: Sort ascending by date for chart consistency ──
      // Table Storage doesn't guarantee row order. Charts need oldest → newest.
      days.sort((a, b) => a.date.localeCompare(b.date));

      return { status: 200, jsonBody: { tenant_id: tenantId, from: startDate, to: endDate, days } };
    }

    // ── ENDPOINT 3: tools ──────────────────────────────────────────────────
    if (endpoint === "tools") {
      const targetMonth = period || new Date().toISOString().slice(0, 7);
      const entities = metricsTable.listEntities({
        queryOptions: { filter: `PartitionKey eq '${tenantId}' and RowKey ge '${targetMonth}-01' and RowKey le '${targetMonth}-31'` },
      });
      const allToolCounts: Record<string, number> = {};
      for await (const entity of entities) {
        const tc = safeJsonParse(entity.toolCounts as string);
        for (const [tool, count] of Object.entries(tc)) {
          allToolCounts[tool] = (allToolCounts[tool] || 0) + (count as number);
        }
      }
      const hourlyRate = parseFloat(process.env.DEFAULT_HOURLY_RATE || "45");
      const tools = Object.entries(allToolCounts).map(([name, count]) => {
        const mins = baselineMinutesForTool(name);
        const hrs = (count * mins) / 60;
        return {
          tool: name,
          category: categoryForTool(name),
          executions: count,
          baseline_minutes_per: mins,
          total_minutes_saved: count * mins,
          hours_saved: Math.round(hrs * 100) / 100,
          cost_saved: Math.round(hrs * hourlyRate * 100) / 100,
        };
      }).sort((a, b) => b.executions - a.executions);

      const categoryTotals: Record<string, { executions: number; hours_saved: number; cost_saved: number }> = {};
      for (const t of tools) {
        if (!categoryTotals[t.category]) categoryTotals[t.category] = { executions: 0, hours_saved: 0, cost_saved: 0 };
        categoryTotals[t.category].executions += t.executions;
        categoryTotals[t.category].hours_saved += t.hours_saved;
        categoryTotals[t.category].cost_saved += t.cost_saved;
      }

      return {
        status: 200,
        jsonBody: {
          tenant_id: tenantId,
          period: targetMonth,
          tools,
          category_totals: Object.entries(categoryTotals).map(([cat, totals]) => ({
            category: cat,
            ...totals,
            hours_saved: Math.round(totals.hours_saved * 100) / 100,
            cost_saved: Math.round(totals.cost_saved * 100) / 100,
          })),
        },
      };
    }

    // ── ENDPOINT 4: events ─────────────────────────────────────────────────
    if (endpoint === "events") {
      const correlationId = request.query.get("correlation_id");
      if (!correlationId) return { status: 400, jsonBody: { error: "correlation_id required" } };

      // FIX 1 enables this query to work: correlationId is now stored as a table column.
      // NOTE: Events ingested BEFORE this fix won't have the column and won't appear
      // in results. Only newly ingested events will be findable by correlation_id.
      const entities = eventsTable.listEntities({
        queryOptions: { filter: `PartitionKey eq '${tenantId}' and correlationId eq '${correlationId}'` },
      });
      const events: any[] = [];
      for await (const entity of entities) {
        events.push(safeJsonParse(entity.payload as string));
      }
      return { status: 200, jsonBody: { tenant_id: tenantId, correlation_id: correlationId, events } };
    }

    // ── ENDPOINT 5: hourly ─────────────────────────────────────────────────
    if (endpoint === "hourly") {
      const targetMonth = period || new Date().toISOString().slice(0, 7);

      const entities = eventsTable.listEntities({
        queryOptions: {
          filter: `PartitionKey eq '${tenantId}'`,
        },
      });

      const byHour: Record<number, number> = {};
      const byDayOfWeek: Record<number, number> = {};
      const byCategory: Record<string, number> = {};
      let totalEvents = 0;

      for (let h = 0; h < 24; h++) byHour[h] = 0;
      for (let d = 0; d < 7; d++) byDayOfWeek[d] = 0;

      for await (const entity of entities) {
        const payload = safeJsonParse(entity.payload as string);
        const ts = payload.timestamp;
        if (!ts) continue;

        // Filter to target month
        if (!ts.startsWith(targetMonth)) continue;

        const dt = new Date(ts);
        byHour[dt.getUTCHours()] = (byHour[dt.getUTCHours()] || 0) + 1;
        byDayOfWeek[dt.getUTCDay()] = (byDayOfWeek[dt.getUTCDay()] || 0) + 1;
        totalEvents++;

        // Category breakdown
        if (payload.tool_category) {
          byCategory[payload.tool_category] = (byCategory[payload.tool_category] || 0) + 1;
        }
        if (payload.event_type === "turn_completed") {
          byCategory["conversations"] = (byCategory["conversations"] || 0) + 1;
        }
      }

      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

      const peakHour = Object.entries(byHour).sort(([, a], [, b]) => b - a)[0];
      const peakDay = Object.entries(byDayOfWeek).sort(([, a], [, b]) => b - a)[0];

      return {
        status: 200,
        jsonBody: {
          tenant_id: tenantId,
          period: targetMonth,
          total_events: totalEvents,
          peak_hour: peakHour ? { hour: parseInt(peakHour[0]), count: peakHour[1], label: `${peakHour[0].padStart(2, "0")}:00 UTC` } : null,
          peak_day: peakDay ? { day_index: parseInt(peakDay[0]), count: peakDay[1], label: dayNames[parseInt(peakDay[0])] } : null,
          by_hour: Object.entries(byHour).map(([hour, count]) => ({
            hour: parseInt(hour),
            label: `${hour.padStart(2, "0")}:00`,
            count,
          })),
          by_day_of_week: Object.entries(byDayOfWeek).map(([day, count]) => ({
            day_index: parseInt(day),
            label: dayNames[parseInt(day)],
            count,
          })),
          by_category: Object.entries(byCategory).map(([category, count]) => ({
            category,
            count,
          })).sort((a, b) => b.count - a.count),
        },
      };
    }

    // ── ENDPOINT 6: users ──────────────────────────────────────────────────
    if (endpoint === "users") {
      const targetMonth = period || new Date().toISOString().slice(0, 7);

      const entities = eventsTable.listEntities({
        queryOptions: {
          filter: `PartitionKey eq '${tenantId}'`,
        },
      });

      const userData: Record<string, {
        conversations: number;
        tool_executions: number;
        first_seen: string;
        last_seen: string;
        tools_used: Record<string, number>;
        agent_types: Record<string, number>;
      }> = {};

      for await (const entity of entities) {
        const payload = safeJsonParse(entity.payload as string);
        const ts = payload.timestamp;
        if (!ts || !ts.startsWith(targetMonth)) continue;

        const userHash = payload.user_hash || "anonymous";

        if (!userData[userHash]) {
          userData[userHash] = {
            conversations: 0,
            tool_executions: 0,
            first_seen: ts,
            last_seen: ts,
            tools_used: {},
            agent_types: {},
          };
        }

        const u = userData[userHash];
        if (ts < u.first_seen) u.first_seen = ts;
        if (ts > u.last_seen) u.last_seen = ts;

        if (payload.event_type === "turn_completed") {
          u.conversations++;
          if (payload.agent_type) {
            u.agent_types[payload.agent_type] = (u.agent_types[payload.agent_type] || 0) + 1;
          }
        } else if (payload.event_type === "tool_executed") {
          u.tool_executions++;
          if (payload.tool_name) {
            u.tools_used[payload.tool_name] = (u.tools_used[payload.tool_name] || 0) + 1;
          }
        }
      }

      const users = Object.entries(userData).map(([hash, data]) => ({
        user_hash: hash,
        conversations: data.conversations,
        tool_executions: data.tool_executions,
        first_seen: data.first_seen,
        last_seen: data.last_seen,
        top_tools: Object.entries(data.tools_used)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([tool, count]) => ({ tool, count })),
        agent_types: data.agent_types,
      })).sort((a, b) => b.conversations - a.conversations);

      return {
        status: 200,
        jsonBody: {
          tenant_id: tenantId,
          period: targetMonth,
          total_unique_users: users.length,
          avg_conversations_per_user: users.length > 0
            ? Math.round((users.reduce((sum, u) => sum + u.conversations, 0) / users.length) * 100) / 100
            : 0,
          avg_tool_executions_per_user: users.length > 0
            ? Math.round((users.reduce((sum, u) => sum + u.tool_executions, 0) / users.length) * 100) / 100
            : 0,
          users,
        },
      };
    }

    // ── ENDPOINT 7: demand ─────────────────────────────────────────────────
    // What employees ask, by HR theme, with the answered/deflected split.
    if (endpoint === "demand") {
      const targetMonth = period || new Date().toISOString().slice(0, 7);
      const { byTopic, taggedTurns, untaggedTurns } = await aggregateTurnTopics(tenantId, targetMonth);

      const topics = Object.entries(byTopic)
        .map(([topic, c]) => ({
          topic,
          total: c.total,
          answered: c.answered,
          deflected: c.deflected,
          not_in_docs: c.not_in_docs,
          escalated: c.escalated,
          answered_rate: c.total > 0 ? Math.round((c.answered / c.total) * 10000) / 100 : 0,
        }))
        .sort((a, b) => b.total - a.total);

      return {
        status: 200,
        jsonBody: {
          tenant_id: tenantId,
          period: targetMonth,
          tagged_turns: taggedTurns,
          untagged_turns: untaggedTurns, // turns from bot builds without coverage fields
          topics,
        },
      };
    }

    // ── ENDPOINT 8: gaps ───────────────────────────────────────────────────
    // What the bot could NOT answer (deflected + not_in_docs), ranked by
    // volume, plus data-quality escalations. Aggregate themes only — never
    // message text (privacy: transcripts stay behind CONVERSATION_CAPTURE).
    if (endpoint === "gaps") {
      const targetMonth = period || new Date().toISOString().slice(0, 7);
      const { byTopic, taggedTurns, untaggedTurns } = await aggregateTurnTopics(tenantId, targetMonth);

      const gaps = Object.entries(byTopic)
        .map(([topic, c]) => ({
          topic,
          deflected: c.deflected,
          not_in_docs: c.not_in_docs,
          escalated: c.escalated,
          unanswered_total: c.deflected + c.not_in_docs,
          topic_total: c.total,
        }))
        .filter(g => g.unanswered_total > 0)
        .sort((a, b) => b.unanswered_total - a.unanswered_total);

      // Escalation events carry an OPTIONAL tenant_id; those without one land
      // in the "unknown" partition, so match on the payload, not the partition.
      const escalations: any[] = [];
      const escalationsByKind: Record<string, number> = {};
      try {
        const escEntities = eventsTable.listEntities({
          queryOptions: { filter: `eventType eq 'escalation'` },
        });
        for await (const entity of escEntities) {
          const p = safeJsonParse(entity.payload as string);
          const ts = p.timestamp;
          if (!ts || !ts.startsWith(targetMonth)) continue;
          if (p.tenant_id && p.tenant_id !== tenantId) continue;
          escalations.push({ kind: p.kind || "unknown", detail: p.detail || "", timestamp: ts });
          escalationsByKind[p.kind || "unknown"] = (escalationsByKind[p.kind || "unknown"] || 0) + 1;
        }
        escalations.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      } catch (err) {
        context.log("[Dashboard] escalation scan failed");
      }

      return {
        status: 200,
        jsonBody: {
          tenant_id: tenantId,
          period: targetMonth,
          tagged_turns: taggedTurns,
          untagged_turns: untaggedTurns,
          gaps,
          escalations: escalations.slice(0, 100),
          escalations_by_kind: Object.entries(escalationsByKind)
            .map(([kind, count]) => ({ kind, count }))
            .sort((a, b) => b.count - a.count),
        },
      };
    }

    // ── Unknown endpoint ───────────────────────────────────────────────────
    return { status: 400, jsonBody: { error: `Unknown endpoint: ${endpoint}`, available: ["summary", "trends", "tools", "events", "hourly", "users", "demand", "gaps"] } };
  } catch (err: any) {
    context.error("[Dashboard] Error:", err);
    return { status: 500, jsonBody: { error: "Internal server error" } };
  }
}

app.http("dashboardApi", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "dashboard",
  handler: dashboardHandler,
});