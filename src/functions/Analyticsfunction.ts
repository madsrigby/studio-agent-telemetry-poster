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
import { baselineMinutesForTool, categoryForTool, baselineForTool, baselinesVersion, hourlyRate } from "../baselines";
import { aggregateRange } from "../aggregation/aggregateDay";
import { tableEventsStore, tableMetricsStore } from "../bi/store";
import { configuredTenants, parseKeyConfig } from "../bi/auth";
import { addDays, isoDate } from "../bi/util";
import { composeDigest, type WeekData } from "../digest/compose";
import { readSendConfig, sendDigest } from "../digest/send";

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

// Baseline precedence and tool categories live in src/baselines.ts (shared with
// the BI API and the aggregation module) — moved verbatim, behaviour unchanged.

// Daily aggregation: re-aggregates the trailing 7 UTC days every night with a
// Replace-upsert, so a missed run self-heals and every known tenant gets a row
// even on a quiet day (the BI API tells "quiet" from "missing" by that row).
// Longer gaps: POST /api/admin/aggregate (src/functions/adminAggregate.ts).
const AGGREGATION_TRAILING_DAYS = 7;

async function dailyAggregation(_timer: unknown, context: InvocationContext): Promise<void> {
  context.log(`[Aggregation] Starting daily metrics (trailing ${AGGREGATION_TRAILING_DAYS} days)`);
  await ensureTables();

  const metrics = tableMetricsStore(metricsTable);
  const events = tableEventsStore(eventsTable);
  const known = new Set<string>([...configuredTenants(parseKeyConfig(process.env.BI_API_KEYS)), ...(await metrics.tenants())]);
  known.delete("unknown");
  const rate = hourlyRate();

  const yesterday = addDays(isoDate(new Date()), -1);
  const from = addDays(yesterday, -(AGGREGATION_TRAILING_DAYS - 1));

  try {
    await aggregateRange(from, yesterday, {
      scanEvents: (ge, le) => events.scanEvents(ge, le),
      upsertMetrics: (e) => metrics.upsert(e),
      knownTenants: Array.from(known),
      rate,
      baselineFn: (t) => baselineForTool(t).minutes,
      baselineEstimatedFn: (t) => baselineForTool(t).estimated,
      baselinesVersion: baselinesVersion({ rate }),
      log: (m) => context.log(m),
    });
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

// ── Digest sending ───────────────────────────────────────────────────────────
// Turns unsent weeklyinsight rows into emails via ACS. Inert unless
// DIGEST_ENABLED=true and ACS_EMAIL_CONNECTION_STRING / DIGEST_FROM /
// DIGEST_RECIPIENTS are all set. Idempotent (sent flag) and self-healing:
// every weekly run retries unsent rows up to 14 days old.

function rowToWeekData(entity: any): WeekData {
  return {
    weekEnd: String(entity.rowKey),
    taggedTurns: Number(entity.taggedTurns) || 0,
    untaggedTurns: Number(entity.untaggedTurns) || 0,
    topTopics: safeJsonParse(entity.topTopics as string, []),
    topGaps: safeJsonParse(entity.topGaps as string, []),
    escalationsByKind: safeJsonParse(entity.escalationsByKind as string, {}),
  };
}

export async function sendPendingDigests(context: InvocationContext): Promise<void> {
  const cfg = readSendConfig();
  if (!cfg) {
    context.log("[Digest] disabled or not configured — skipping send");
    return;
  }
  const dashboardUrl = process.env.DASHBOARD_URL || "https://www.mystudioagent.ai";
  const minSensitiveCount = parseInt(process.env.DIGEST_MIN_SENSITIVE_COUNT || "5", 10);
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const allowlist = (process.env.DIGEST_TENANT_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const entities = insightTable.listEntities();
  for await (const entity of entities) {
    const tenantId = String(entity.partitionKey);
    if (entity.sent === true) continue;
    if (String(entity.rowKey) < cutoff) continue;
    if (allowlist.length ? !allowlist.includes(tenantId) : tenantId === "unknown") continue;

    const current = rowToWeekData(entity);
    let previous: WeekData | null = null;
    try {
      const prevKey = new Date(new Date(`${current.weekEnd}T00:00:00Z`).getTime() - 7 * 86400000)
        .toISOString()
        .split("T")[0];
      const prevEntity = await insightTable.getEntity(tenantId, prevKey);
      previous = rowToWeekData(prevEntity);
    } catch {
      // no prior week — deltas omitted
    }

    const sync = await computeSyncHealth(context);
    const digest = composeDigest(current, previous, sync, { dashboardUrl, minSensitiveCount });

    try {
      const id = await sendDigest(digest, cfg);
      await insightTable.updateEntity(
        { partitionKey: tenantId, rowKey: String(entity.rowKey), sent: true, sentAt: new Date().toISOString(), sendId: id, mode: digest.mode },
        "Merge",
      );
      context.log(`[Digest] sent ${tenantId} week-to-${current.weekEnd} mode=${digest.mode} to ${cfg.recipients.length} recipient(s)`);
    } catch (err: any) {
      await insightTable
        .updateEntity(
          { partitionKey: tenantId, rowKey: String(entity.rowKey), sendError: String(err?.message || err).slice(0, 512) },
          "Merge",
        )
        .catch(() => {});
      context.error(`[Digest] send failed ${tenantId} week-to-${current.weekEnd}: ${err?.message || err}`);
    }
  }
}

async function weeklyInsightAndDigest(timer: unknown, context: InvocationContext): Promise<void> {
  await weeklyInsight(timer, context);
  await sendPendingDigests(context);
}

app.timer("weeklyInsight", {
  schedule: "0 0 6 * * 1",
  handler: weeklyInsightAndDigest,
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

// GUIDs, probe tenants ("queue-probe") and correlation ids all match; quotes and spaces do not.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

async function dashboardHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  await ensureTables();

  const tenantId = request.query.get("tenant_id");
  if (!tenantId) return { status: 400, jsonBody: { error: "tenant_id required" } };
  // Identifier-shaped only: closes the OData filter injection on this anonymous route.
  if (!SAFE_ID.test(tenantId)) return { status: 400, jsonBody: { error: "tenant_id invalid" } };

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
      if (!SAFE_ID.test(correlationId)) return { status: 400, jsonBody: { error: "correlation_id invalid" } };

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