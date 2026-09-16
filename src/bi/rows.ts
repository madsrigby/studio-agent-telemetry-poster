// rows.ts — pure flatteners from telemetrymetrics entities to BI rows.
// Rows are FLAT (string | number | boolean | null) so a BI warehouse can
// ingest them without transformation. Every row has row_id and tenant_id.

import type { BaselineInfo, CategorySource } from "../baselines";
import { SENSITIVE_TOPICS, type TopicCount } from "../aggregation/aggregateDay";
import { daysInMonth, isoMonth, round2, safeJsonParse } from "./util";

export type Flat = string | number | boolean | null;
export type FlatRow = Record<string, Flat> & { row_id: string; tenant_id: string };

export interface RowCtx {
  tenantId: string;
  rate: number;
  baselinesVersion: string;
  baselineFn: (tool: string) => BaselineInfo;
  categoryFn: (tool: string) => { category: string; source: CategorySource };
  currency?: string;
}

const CURRENCY = "GBP";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rate(n: number | null, d: number | null): number | null {
  if (n === null || d === null) return null;
  return d > 0 ? round2(n / d) : 0;
}

function recompute(toolCounts: Record<string, number>, ctx: RowCtx): { minutes: number; hours: number; cost: number } {
  let minutes = 0;
  for (const [tool, count] of Object.entries(toolCounts)) minutes += (count as number) * ctx.baselineFn(tool).minutes;
  const hours = minutes / 60;
  return { minutes, hours: round2(hours), cost: round2(hours * ctx.rate) };
}

// ── engine verdicts (turn_outcome), null when the row predates them ──────────

const OUTCOME_NULLS = {
  outcome_answered: null,
  outcome_not_covered: null,
  outcome_retrieval_miss: null,
  outcome_no_claim_kept: null,
  outcome_tool_failed: null,
  outcome_out_of_scope: null,
  outcome_other: null,
  outcome_sample_n: null,
  retrieval_miss_rate: null,
  not_covered_rate: null,
  tool_failed_rate: null,
  total_tokens: null,
  tool_calls: null,
  tool_errors: null,
  claims_kept: null,
  claims_dropped: null,
  claims_sample_n: null,
} as const;

function outcomeColumns(entity: any): Record<keyof typeof OUTCOME_NULLS, number | null> {
  if (typeof entity?.outcomeCounts !== "string") return { ...OUTCOME_NULLS };
  const c = safeJsonParse(entity.outcomeCounts, {}) as Record<string, number>;
  const n = num(entity.outcomeSampleN) ?? 0;
  const g = (k: string) => num(c[k]) ?? 0;
  return {
    outcome_answered: g("ANSWERED"),
    outcome_not_covered: g("NOT_COVERED"),
    outcome_retrieval_miss: g("RETRIEVAL_MISS"),
    outcome_no_claim_kept: g("NO_CLAIM_KEPT"),
    outcome_tool_failed: g("TOOL_FAILED"),
    outcome_out_of_scope: g("OUT_OF_SCOPE"),
    outcome_other: g("other"),
    outcome_sample_n: n,
    retrieval_miss_rate: rate(g("RETRIEVAL_MISS"), n),
    not_covered_rate: rate(g("NOT_COVERED"), n),
    tool_failed_rate: rate(g("TOOL_FAILED"), n),
    total_tokens: num(entity.totalTokens) ?? 0,
    tool_calls: num(entity.toolCallsTotal) ?? 0,
    tool_errors: num(entity.toolErrorsTotal) ?? 0,
    claims_kept: num(entity.claimsKept) ?? 0,
    claims_dropped: num(entity.claimsDropped) ?? 0,
    claims_sample_n: num(entity.claimsSampleN) ?? 0,
  };
}

// ── daily ─────────────────────────────────────────────────────────────────────

export function dailyRow(ctx: RowCtx, date: string, entity: any | null): FlatRow {
  const base = { row_id: date, tenant_id: ctx.tenantId, date };
  if (!entity) {
    return {
      ...base,
      aggregation_status: "missing",
      computed_at: null,
      turns: null,
      turns_substantive: null,
      tool_executions: null,
      unique_users: null,
      success_count: null,
      error_count: null,
      empty_reply_count: null,
      success_rate: null,
      error_rate: null,
      empty_reply_rate: null,
      avg_latency_ms: null,
      p95_latency_ms: null,
      latency_sample_n: null,
      employee_turns: null,
      admin_turns: null,
      baseline_minutes: null,
      hours_saved: null,
      cost_saved: null,
      hours_saved_current: null,
      cost_saved_current: null,
      baselines_version: null,
      baseline_status: null,
      ...OUTCOME_NULLS,
      build_sha: null,
      build_shas: null,
      hourly_rate: ctx.rate,
      currency: ctx.currency ?? CURRENCY,
    };
  }
  const turns = num(entity.totalTurns) ?? 0;
  const success = num(entity.successCount) ?? 0;
  const errors = num(entity.errorCount) ?? 0;
  const empties = num(entity.emptyReplyCount) ?? 0;
  const toolCounts = safeJsonParse(entity.toolCounts as string, {}) as Record<string, number>;
  const current = recompute(toolCounts, ctx);
  return {
    ...base,
    aggregation_status: "complete",
    computed_at: typeof entity.computedAt === "string" ? entity.computedAt : null,
    turns,
    turns_substantive: num(entity.turnsSubstantive),
    tool_executions: num(entity.totalToolExecutions) ?? 0,
    unique_users: num(entity.uniqueUsers) ?? 0,
    success_count: success,
    error_count: errors,
    empty_reply_count: empties,
    success_rate: rate(success, turns),
    error_rate: rate(errors, turns),
    empty_reply_rate: rate(empties, turns),
    avg_latency_ms: num(entity.avgLatencyMs) ?? 0,
    p95_latency_ms: num(entity.p95LatencyMs) ?? 0,
    latency_sample_n: num(entity.latencySampleN),
    employee_turns: num(entity.employeeTurns) ?? 0,
    admin_turns: num(entity.adminTurns) ?? 0,
    baseline_minutes: num(entity.totalBaselineMinutes) ?? 0,
    hours_saved: num(entity.hoursSaved) ?? 0,
    cost_saved: num(entity.costSaved) ?? 0,
    hours_saved_current: current.hours,
    cost_saved_current: current.cost,
    baselines_version: typeof entity.baselinesVersion === "string" ? entity.baselinesVersion : null,
    baseline_status: typeof entity.baselineStatus === "string" ? entity.baselineStatus : null,
    ...outcomeColumns(entity),
    build_sha: typeof entity.buildSha === "string" && entity.buildSha ? entity.buildSha : null,
    build_shas: typeof entity.buildShas === "string" ? (safeJsonParse(entity.buildShas, []) as string[]).join(",") || null : null,
    hourly_rate: num(entity.hourlyRate) ?? ctx.rate,
    currency: ctx.currency ?? CURRENCY,
  };
}

// ── tool_daily ────────────────────────────────────────────────────────────────

export function toolDailyRows(ctx: RowCtx, date: string, entity: any): FlatRow[] {
  const toolCounts = safeJsonParse(entity?.toolCounts as string, {}) as Record<string, number>;
  const out: FlatRow[] = [];
  for (const [tool, count] of Object.entries(toolCounts)) {
    if (!(typeof count === "number") || count <= 0) continue;
    const b = ctx.baselineFn(tool);
    const c = ctx.categoryFn(tool);
    const minutes = count * b.minutes;
    const hours = minutes / 60;
    out.push({
      row_id: `${date}|${tool}`,
      tenant_id: ctx.tenantId,
      date,
      tool,
      category: c.category,
      category_source: c.source,
      executions: count,
      baseline_minutes: b.minutes,
      baseline_source: b.source,
      baseline_estimated: b.estimated,
      minutes_saved: minutes,
      hours_saved: round2(hours),
      cost_saved: round2(hours * ctx.rate),
      hourly_rate: ctx.rate,
      currency: ctx.currency ?? CURRENCY,
    });
  }
  return out;
}

// ── topics_daily ──────────────────────────────────────────────────────────────

export const DEFAULT_SENSITIVE_FLOOR = 5;

export function topicsDailyRows(ctx: RowCtx, date: string, entity: any, floor: number = DEFAULT_SENSITIVE_FLOOR): FlatRow[] {
  const raw = entity?.topicCounts;
  if (typeof raw !== "string" || !raw) return [];
  const topicCounts = safeJsonParse(raw, {}) as Record<string, TopicCount>;
  const out: FlatRow[] = [];
  for (const [topic, c] of Object.entries(topicCounts)) {
    const turns = num(c.turns) ?? 0;
    const suppress = SENSITIVE_TOPICS.includes(topic) && turns > 0 && turns < floor;
    const v = (n: unknown) => (suppress ? null : (num(n) ?? 0));
    out.push({
      row_id: `${date}|${topic}`,
      tenant_id: ctx.tenantId,
      date,
      topic,
      turns: v(c.turns),
      answered_ok: v(c.answered_ok),
      answered_failed: v(c.answered_failed),
      deflected: v(c.deflected),
      not_in_docs: v(c.not_in_docs),
      escalated: v(c.escalated),
      coverage_unknown: v(c.unknown),
      suppressed: suppress,
    });
  }
  return out;
}

// ── monthly ───────────────────────────────────────────────────────────────────

export interface MonthlyInput {
  month: string;
  entities: any[]; // telemetrymetrics rows for the month, any order
  uniqueUsers: number | null; // true monthly uniques from raw events, null if unavailable
  hasTurnData: boolean;
  now: Date;
}

/**
 * Mirrors dashboardApi `summary` exactly (same names, same rounding) so the
 * reconciliation gate is an equality check, then adds frozen sums, a
 * turn-weighted latency and completeness columns.
 */
export function monthlyRow(ctx: RowCtx, input: MonthlyInput): FlatRow {
  const { month, entities, now } = input;
  let totalTurns = 0, totalToolExecs = 0, successTotal = 0, employeeTurns = 0, adminTurns = 0;
  let avgLatencySum = 0, latencyDays = 0, p95Max = 0;
  let frozenCost = 0, frozenHours = 0;
  let weightedSum = 0, weightedN = 0;
  let maxDailyUnique = 0;
  const allToolCounts: Record<string, number> = {};
  let anyEstimated = false;

  for (const e of entities) {
    const t = num(e.totalTurns) ?? 0;
    totalTurns += t;
    totalToolExecs += num(e.totalToolExecutions) ?? 0;
    successTotal += num(e.successCount) ?? 0;
    employeeTurns += num(e.employeeTurns) ?? 0;
    adminTurns += num(e.adminTurns) ?? 0;
    frozenCost += num(e.costSaved) ?? 0;
    frozenHours += num(e.hoursSaved) ?? 0;
    maxDailyUnique = Math.max(maxDailyUnique, num(e.uniqueUsers) ?? 0);
    if (e.baselineStatus === "estimated") anyEstimated = true;
    const avgLat = num(e.avgLatencyMs) ?? 0;
    if (avgLat > 0) {
      avgLatencySum += avgLat;
      latencyDays++;
      const n = num(e.latencySampleN) ?? t;
      weightedSum += avgLat * n;
      weightedN += n;
    }
    const p95 = num(e.p95LatencyMs) ?? 0;
    if (p95 > p95Max) p95Max = p95;
    const tc = safeJsonParse(e.toolCounts as string, {}) as Record<string, number>;
    for (const [tool, count] of Object.entries(tc)) allToolCounts[tool] = (allToolCounts[tool] || 0) + (count as number);
  }

  const current = recompute(allToolCounts, ctx);
  const dim = daysInMonth(month);
  const currentMonth = isoMonth(now);
  const isComplete = month < currentMonth;

  return {
    row_id: month,
    tenant_id: ctx.tenantId,
    month,
    is_complete_month: isComplete,
    days_in_month: dim,
    days_aggregated: entities.length,
    has_turn_data: input.hasTurnData,
    // ── hero_metrics parity block (names + formulas from dashboardApi summary) ──
    cost_saved: current.cost,
    hours_saved: current.hours,
    self_service_rate: totalTurns > 0 ? Math.round((successTotal / totalTurns) * 10000) / 100 : 0,
    total_conversations: totalTurns,
    total_tool_executions: totalToolExecs,
    unique_users: input.uniqueUsers ?? maxDailyUnique,
    unique_users_exact: input.uniqueUsers !== null,
    avg_latency_ms: latencyDays > 0 ? Math.round(avgLatencySum / latencyDays) : 0,
    p95_latency_ms: p95Max,
    error_rate: totalTurns > 0 ? Math.round(((totalTurns - successTotal) / totalTurns) * 10000) / 100 : 0,
    employee_turns: employeeTurns,
    admin_turns: adminTurns,
    projected_annual_savings: Math.round(current.cost * 12 * 100) / 100,
    projected_annual_hours: Math.round(current.hours * 12 * 100) / 100,
    // ── additions ──
    success_count: successTotal,
    cost_saved_frozen: round2(frozenCost),
    hours_saved_frozen: round2(frozenHours),
    avg_latency_ms_weighted: weightedN > 0 ? Math.round(weightedSum / weightedN) : 0,
    baseline_status: anyEstimated ? "estimated" : "confirmed",
    baselines_version: ctx.baselinesVersion,
    hourly_rate: ctx.rate,
    currency: ctx.currency ?? CURRENCY,
  };
}

// ── tool_catalog ──────────────────────────────────────────────────────────────

export function catalogRows(ctx: RowCtx, tools: string[], inCatalog: (tool: string) => { baseline: number | null; write: boolean | null }): FlatRow[] {
  return tools.map((tool) => {
    const b = ctx.baselineFn(tool);
    const c = ctx.categoryFn(tool);
    const cat = inCatalog(tool);
    return {
      row_id: tool,
      tenant_id: ctx.tenantId,
      tool,
      category: c.category,
      category_source: c.source,
      is_write: cat.write,
      catalog_baseline_minutes: cat.baseline,
      effective_baseline_minutes: b.minutes,
      baseline_source: b.source,
      baseline_estimated: b.estimated,
      in_catalog: cat.baseline !== null,
      hourly_rate: ctx.rate,
      currency: ctx.currency ?? CURRENCY,
    };
  });
}

// ── guard ─────────────────────────────────────────────────────────────────────

export function assertFlat(row: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(row)) {
    const t = typeof v;
    if (v === null || t === "string" || t === "number" || t === "boolean") continue;
    throw new Error(`row column ${k} is not flat: ${t}`);
  }
  if (typeof row.row_id !== "string" || !row.row_id) throw new Error("row_id missing");
  if (typeof row.tenant_id !== "string" || !row.tenant_id) throw new Error("tenant_id missing");
}
