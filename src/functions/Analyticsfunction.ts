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

// ── Table Storage Setup ──────────────────────────────────────────────────────

const connectionString =
  process.env.TELEMETRY_QUEUE_CONNECTION_STRING ||
  process.env.AzureWebJobsStorage ||
  "";

const eventsTable = TableClient.fromConnectionString(connectionString, "telemetryevents");
const metricsTable = TableClient.fromConnectionString(connectionString, "telemetrymetrics");

let tablesReady = false;
async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  await eventsTable.createTable().catch(() => {});
  await metricsTable.createTable().catch(() => {});
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

async function writeEventToTable(event: any, context: InvocationContext): Promise<void> {
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

    if (!["turn_completed", "tool_executed"].includes(body.event_type)) {
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

const BASELINE_MINUTES: Record<string, number> = {
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

  const hourlyRate = parseFloat(process.env.DEFAULT_HOURLY_RATE || "25");

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
      for (const [toolName, count] of Object.entries(toolCounts)) {
        totalBaselineMinutes += count * (BASELINE_MINUTES[toolName] || 3);
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
// TRIGGER 3: HTTP — Dashboard API (6 endpoints)
// ══════════════════════════════════════════════════════════════════════════════

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

      return {
        status: 200,
        jsonBody: {
          tenant_id: tenantId,
          period: targetMonth,
          // ── FIX 4: Readiness flag for frontend ──
          // When false, Page 4 (Performance) shows EmptyState instead of misleading zeros.
          // When true, at least one turn_completed event exists — zeros are real zeros.
          has_turn_data: hasTurnData,
          hero_metrics: {
            cost_saved: Math.round(totalCostSaved * 100) / 100,
            hours_saved: Math.round(totalHoursSaved * 100) / 100,
            self_service_rate: turnTotal > 0 ? Math.round((successTotal / turnTotal) * 10000) / 100 : 0,
            total_conversations: totalTurns,
            total_tool_executions: totalToolExecs,
            unique_users: monthUniqueUsers.size > 0 ? monthUniqueUsers.size : 0,  // ← FIX 2: true monthly uniques
            avg_latency_ms: latencyDays > 0 ? Math.round(avgLatencySum / latencyDays) : 0,
            p95_latency_ms: p95Max,
            error_rate: turnTotal > 0 ? Math.round(((turnTotal - successTotal) / turnTotal) * 10000) / 100 : 0,
            employee_turns: employeeTurns,
            admin_turns: adminTurns,
            projected_annual_savings: Math.round(totalCostSaved * 12 * 100) / 100,
            projected_annual_hours: Math.round(totalHoursSaved * 12 * 100) / 100,
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
      const hourlyRate = parseFloat(process.env.DEFAULT_HOURLY_RATE || "25");
      const tools = Object.entries(allToolCounts).map(([name, count]) => {
        const mins = BASELINE_MINUTES[name] || 3;
        const hrs = (count * mins) / 60;
        return {
          tool: name,
          category: name.startsWith("create") || name.startsWith("update") || name.startsWith("cancel") ? "write"
            : name.startsWith("approve") || name.startsWith("reject") ? "policy"
            : name.startsWith("resolve") ? "resolver"
            : "read",
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

    // ── Unknown endpoint ───────────────────────────────────────────────────
    return { status: 400, jsonBody: { error: `Unknown endpoint: ${endpoint}`, available: ["summary", "trends", "tools", "events", "hourly", "users"] } };
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