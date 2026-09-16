// aggregateDay.ts — one UTC day of raw events → one telemetrymetrics row per
// tenant. Pure math in computeDayMetrics; storage behind small interfaces so the
// timer, the admin backfill and the tests share one implementation.
//
// Every row is written with "Replace", so re-running a day is idempotent. A
// tenant with NO events on a day still gets a zero row when it is a known
// tenant — that is how the BI API tells "quiet day" from "aggregation missing".

import { safeJsonParse, invertedTs, eachDay, round2 } from "../bi/util";

export const SENSITIVE_TOPICS = ["conduct_grievance", "wellbeing"];
export const KNOWN_COVERAGE = ["answered", "deflected", "not_in_docs", "escalated"] as const;
export const UNTAGGED_TOPIC = "untagged";
export const OUTCOMES = ["ANSWERED", "NOT_COVERED", "RETRIEVAL_MISS", "TOOL_FAILED", "OUT_OF_SCOPE"] as const;

export interface OutcomeStats {
  counts: Record<string, number>; // OUTCOMES ∪ "other"
  sampleN: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
  claimsKept: number;
  claimsDropped: number;
  claimsSampleN: number; // turns where the attributed path ran (claims >= 0)
}

export interface TopicCount {
  turns: number;
  answered_ok: number;
  answered_failed: number;
  deflected: number;
  not_in_docs: number;
  escalated: number;
  unknown: number;
}

export interface DayMetrics {
  totalTurns: number;
  turnsSubstantive: number;
  totalToolExecutions: number;
  uniqueUsers: number;
  successCount: number;
  errorCount: number;
  emptyReplyCount: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  latencySampleN: number;
  employeeTurns: number;
  adminTurns: number;
  toolCounts: Record<string, number>;
  totalBaselineMinutes: number;
  hoursSaved: number;
  costSaved: number;
  hourlyRate: number;
  baselinesVersion: string;
  baselineStatus: "confirmed" | "estimated";
  taggedTurns: number;
  untaggedTurns: number;
  topicCounts: Record<string, TopicCount>;
  outcomes: OutcomeStats;
  /** distinct build_sha values seen on turns that day; newest last */
  buildShas: string[];
  buildSha: string;
}

export interface ComputeInput {
  turns: any[];
  toolExecs: any[];
  /** turn_outcome payloads (engine verdicts); optional for old callers */
  outcomes?: any[];
  rate: number;
  baselineFn: (tool: string) => number;
  baselineEstimatedFn: (tool: string) => boolean;
  baselinesVersion: string;
}

function emptyTopic(): TopicCount {
  return { turns: 0, answered_ok: 0, answered_failed: 0, deflected: 0, not_in_docs: 0, escalated: 0, unknown: 0 };
}

export function computeDayMetrics(input: ComputeInput): DayMetrics {
  const { turns, toolExecs, rate, baselineFn, baselineEstimatedFn, baselinesVersion } = input;
  const outcomeEvents = input.outcomes ?? [];

  const users = new Set<string>();
  for (const t of turns) if (t.user_hash) users.add(t.user_hash);

  const successCount = turns.filter((t) => t.outcome === "success").length;
  const errorCount = turns.filter((t) => t.outcome === "error").length;
  const emptyCount = turns.filter((t) => t.outcome === "empty_reply").length;
  const turnsSubstantive = turns.filter((t) => t.relevance_result_code !== "instant_cache").length;

  const latencies = turns
    .map((t) => t.latency_total_ms)
    .filter((l) => typeof l === "number" && Number.isFinite(l))
    .sort((a, b) => a - b);
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p95Latency = latencies.length > 0 ? latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] : 0;

  const toolCounts: Record<string, number> = {};
  for (const exec of toolExecs) {
    const name = exec.tool_name || "unknown";
    toolCounts[name] = (toolCounts[name] || 0) + 1;
  }

  let totalBaselineMinutes = 0;
  let anyEstimated = false;
  for (const exec of toolExecs) {
    const toolName = exec.tool_name || "unknown";
    // Supports explicit per-event estimate from handbook instrumentation, else falls back.
    const manualMinutes = Number(exec.estimated_manual_minutes);
    const baseline = Number.isFinite(manualMinutes) && manualMinutes > 0 ? manualMinutes : baselineFn(toolName);
    totalBaselineMinutes += baseline;
    if (baselineEstimatedFn(toolName)) anyEstimated = true;
  }

  const hoursSaved = totalBaselineMinutes / 60;
  const costSaved = hoursSaved * rate;

  // Topic × coverage × outcome. answer_coverage "answered" on a failed turn is
  // deliberate in the bot (classifyCoverage), so it is split here.
  const topicCounts: Record<string, TopicCount> = {};
  let tagged = 0;
  let untagged = 0;
  for (const t of turns) {
    const hasCoverage = typeof t.answer_coverage === "string" && t.answer_coverage.length > 0;
    const hasTopic = typeof t.topic === "string" && t.topic.length > 0;
    let topic: string;
    if (!hasCoverage && !hasTopic) {
      untagged++;
      topic = UNTAGGED_TOPIC;
    } else {
      tagged++;
      topic = hasTopic ? t.topic : "other";
    }
    if (!topicCounts[topic]) topicCounts[topic] = emptyTopic();
    const c = topicCounts[topic];
    c.turns++;
    const cov = hasCoverage ? String(t.answer_coverage) : "";
    if (cov === "answered") {
      if (t.outcome === "success") c.answered_ok++;
      else c.answered_failed++;
    } else if (cov === "deflected") c.deflected++;
    else if (cov === "not_in_docs") c.not_in_docs++;
    else if (cov === "escalated") c.escalated++;
    else c.unknown++;
  }

  const oc: Record<string, number> = {};
  for (const o of OUTCOMES) oc[o] = 0;
  oc.other = 0;
  const outcomes: OutcomeStats = { counts: oc, sampleN: 0, totalTokens: 0, toolCalls: 0, toolErrors: 0, claimsKept: 0, claimsDropped: 0, claimsSampleN: 0 };
  for (const o of outcomeEvents) {
    outcomes.sampleN++;
    const k = typeof o.outcome === "string" && (OUTCOMES as readonly string[]).includes(o.outcome) ? o.outcome : "other";
    oc[k]++;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    outcomes.totalTokens += n(o.total_tokens);
    outcomes.toolCalls += n(o.tool_calls);
    outcomes.toolErrors += n(o.tool_errors);
    if (typeof o.claims_kept === "number" && o.claims_kept >= 0) {
      outcomes.claimsSampleN++;
      outcomes.claimsKept += o.claims_kept;
      outcomes.claimsDropped += n(o.claims_dropped);
    }
  }

  const shaByTime = turns
    .filter((t) => typeof t.build_sha === "string" && t.build_sha)
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  const buildShas = Array.from(new Set(shaByTime.map((t) => String(t.build_sha))));
  const buildSha = buildShas.length ? buildShas[buildShas.length - 1] : "";

  return {
    totalTurns: turns.length,
    turnsSubstantive,
    totalToolExecutions: toolExecs.length,
    uniqueUsers: users.size,
    successCount,
    errorCount,
    emptyReplyCount: emptyCount,
    successRate: turns.length > 0 ? successCount / turns.length : 0,
    avgLatencyMs: Math.round(avgLatency),
    p95LatencyMs: Math.round(p95Latency),
    latencySampleN: latencies.length,
    employeeTurns: turns.filter((t) => t.agent_type === "employee").length,
    adminTurns: turns.filter((t) => t.agent_type === "admin").length,
    toolCounts,
    totalBaselineMinutes,
    hoursSaved: round2(hoursSaved),
    costSaved: round2(costSaved),
    hourlyRate: rate,
    baselinesVersion,
    baselineStatus: anyEstimated ? "estimated" : "confirmed",
    taggedTurns: tagged,
    untaggedTurns: untagged,
    topicCounts,
    outcomes,
    buildShas,
    buildSha,
  };
}

export function dayRowKeyBounds(dateStr: string): { rowKeyGe: string; rowKeyLe: string } {
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  const dayEnd = new Date(`${dateStr}T23:59:59.999Z`).getTime();
  // Inverted keys: the LATER instant has the SMALLER key.
  return { rowKeyGe: invertedTs(dayEnd), rowKeyLe: invertedTs(dayStart) };
}

/** Shape of a telemetrymetrics entity as written by aggregateDay. */
export function metricsEntity(tenantId: string, dateStr: string, m: DayMetrics, computedAt: string): Record<string, any> {
  return {
    partitionKey: tenantId,
    rowKey: dateStr,
    computedAt,
    totalTurns: m.totalTurns,
    turnsSubstantive: m.turnsSubstantive,
    totalToolExecutions: m.totalToolExecutions,
    uniqueUsers: m.uniqueUsers,
    successCount: m.successCount,
    errorCount: m.errorCount,
    emptyReplyCount: m.emptyReplyCount,
    successRate: m.successRate,
    avgLatencyMs: m.avgLatencyMs,
    p95LatencyMs: m.p95LatencyMs,
    latencySampleN: m.latencySampleN,
    employeeTurns: m.employeeTurns,
    adminTurns: m.adminTurns,
    toolCounts: JSON.stringify(m.toolCounts),
    totalBaselineMinutes: m.totalBaselineMinutes,
    hoursSaved: m.hoursSaved,
    costSaved: m.costSaved,
    hourlyRate: m.hourlyRate,
    baselinesVersion: m.baselinesVersion,
    baselineStatus: m.baselineStatus,
    taggedTurns: m.taggedTurns,
    untaggedTurns: m.untaggedTurns,
    topicCounts: JSON.stringify(m.topicCounts),
    outcomeCounts: JSON.stringify(m.outcomes.counts),
    outcomeSampleN: m.outcomes.sampleN,
    totalTokens: m.outcomes.totalTokens,
    toolCallsTotal: m.outcomes.toolCalls,
    toolErrorsTotal: m.outcomes.toolErrors,
    claimsKept: m.outcomes.claimsKept,
    claimsDropped: m.outcomes.claimsDropped,
    claimsSampleN: m.outcomes.claimsSampleN,
    buildShas: JSON.stringify(m.buildShas),
    buildSha: m.buildSha,
  };
}

export interface RawEventRow {
  partitionKey: string;
  eventType: string;
  payload: string;
}

export interface AggregateDeps {
  /** Raw events whose RowKey lies in [rowKeyGe, rowKeyLe] across all partitions. */
  scanEvents(rowKeyGe: string, rowKeyLe: string): AsyncIterable<RawEventRow>;
  /** Replace-upsert of one telemetrymetrics entity. */
  upsertMetrics(entity: Record<string, any>): Promise<void>;
  /** Tenants that get a zero row even when they had no events. */
  knownTenants: string[];
  rate: number;
  baselineFn: (tool: string) => number;
  baselineEstimatedFn: (tool: string) => boolean;
  baselinesVersion: string;
  log: (msg: string) => void;
  now?: () => Date;
}

export const MAX_RANGE_DAYS = 92;

export async function aggregateDay(dateStr: string, deps: AggregateDeps): Promise<{ date: string; tenants: string[] }> {
  const { rowKeyGe, rowKeyLe } = dayRowKeyBounds(dateStr);
  const tenantData: Record<string, { turns: any[]; toolExecs: any[]; outcomes: any[] }> = {};
  const ensure = (t: string) => {
    if (!tenantData[t]) tenantData[t] = { turns: [], toolExecs: [], outcomes: [] };
    return tenantData[t];
  };
  for (const t of deps.knownTenants) ensure(t);

  for await (const row of deps.scanEvents(rowKeyGe, rowKeyLe)) {
    const tenantId = row.partitionKey || "unknown";
    const payload = safeJsonParse(row.payload);
    if (row.eventType === "turn_completed") ensure(tenantId).turns.push(payload);
    else if (row.eventType === "tool_executed") ensure(tenantId).toolExecs.push(payload);
    else if (row.eventType === "turn_outcome") ensure(tenantId).outcomes.push(payload);
  }

  const computedAt = (deps.now ? deps.now() : new Date()).toISOString();
  const written: string[] = [];
  for (const [tenantId, data] of Object.entries(tenantData)) {
    const m = computeDayMetrics({
      turns: data.turns,
      toolExecs: data.toolExecs,
      outcomes: data.outcomes,
      rate: deps.rate,
      baselineFn: deps.baselineFn,
      baselineEstimatedFn: deps.baselineEstimatedFn,
      baselinesVersion: deps.baselinesVersion,
    });
    await deps.upsertMetrics(metricsEntity(tenantId, dateStr, m, computedAt));
    written.push(tenantId);
    deps.log(`[Aggregation] ${tenantId} ${dateStr}: ${m.totalTurns} turns, ${m.totalToolExecutions} tools, £${m.costSaved.toFixed(2)} saved`);
  }
  return { date: dateStr, tenants: written };
}

export async function aggregateRange(
  from: string,
  to: string,
  deps: AggregateDeps
): Promise<{ days: number; tenantsWritten: number; results: Array<{ date: string; tenants: string[] }> }> {
  const days = eachDay(from, to);
  if (days.length === 0) throw new Error(`empty range ${from}..${to}`);
  if (days.length > MAX_RANGE_DAYS) throw new Error(`range too large: ${days.length} days (max ${MAX_RANGE_DAYS})`);
  const results: Array<{ date: string; tenants: string[] }> = [];
  let tenantsWritten = 0;
  for (const d of days) {
    const r = await aggregateDay(d, deps);
    results.push(r);
    tenantsWritten += r.tenants.length;
  }
  return { days: days.length, tenantsWritten, results };
}
