import { describe, expect, it } from "vitest";
import { assertFlat, catalogRows, dailyRow, monthlyRow, toolDailyRows, topicsDailyRows, type RowCtx } from "../src/bi/rows";
import { computeDayMetrics, metricsEntity } from "../src/aggregation/aggregateDay";

const ctx: RowCtx = {
  tenantId: "t1",
  rate: 45,
  baselinesVersion: "v123",
  baselineFn: (tool) => (tool === "list_departments" ? { minutes: 2, source: "catalog", estimated: false } : { minutes: 4, source: "catalog", estimated: tool === "get_my_holiday_balance" }),
  categoryFn: (tool) => ({ category: tool.startsWith("create") ? "write" : "read", source: "catalog" }),
};

function entity(overrides: Record<string, unknown> = {}) {
  return {
    partitionKey: "t1",
    rowKey: "2026-09-10",
    computedAt: "2026-09-11T02:00:00.000Z",
    totalTurns: 10,
    turnsSubstantive: 8,
    totalToolExecutions: 3,
    uniqueUsers: 4,
    successCount: 8,
    errorCount: 1,
    emptyReplyCount: 1,
    successRate: 0.8,
    avgLatencyMs: 1200,
    p95LatencyMs: 3000,
    latencySampleN: 10,
    employeeTurns: 7,
    adminTurns: 3,
    toolCounts: JSON.stringify({ list_departments: 2, get_my_holiday_balance: 1 }),
    totalBaselineMinutes: 8,
    hoursSaved: 0.13,
    costSaved: 6.0,
    hourlyRate: 45,
    baselinesVersion: "old",
    baselineStatus: "estimated",
    topicCounts: JSON.stringify({
      holiday: { turns: 6, answered_ok: 5, answered_failed: 1, deflected: 0, not_in_docs: 0, escalated: 0, unknown: 0 },
      wellbeing: { turns: 2, answered_ok: 2, answered_failed: 0, deflected: 0, not_in_docs: 0, escalated: 0, unknown: 0 },
      conduct_grievance: { turns: 6, answered_ok: 1, answered_failed: 0, deflected: 5, not_in_docs: 0, escalated: 0, unknown: 0 },
    }),
    ...overrides,
  };
}

describe("dailyRow", () => {
  it("emits nulls with status missing when there is no entity", () => {
    const r = dailyRow(ctx, "2026-09-10", null);
    expect(r.aggregation_status).toBe("missing");
    expect(r.turns).toBeNull();
    expect(r.cost_saved).toBeNull();
    expect(r.hourly_rate).toBe(45);
    assertFlat(r);
  });
  it("keeps frozen values and recomputes current ones from tool counts", () => {
    const r = dailyRow(ctx, "2026-09-10", entity());
    expect(r.aggregation_status).toBe("complete");
    expect(r.cost_saved).toBe(6.0); // frozen at aggregation
    // current: 2×2 + 1×4 = 8 min = 0.1333 h × 45 = 6.00
    expect(r.hours_saved_current).toBe(0.13);
    expect(r.cost_saved_current).toBe(6.0);
    expect(r.success_rate).toBe(0.8);
    expect(r.error_rate).toBe(0.1);
    expect(r.empty_reply_rate).toBe(0.1);
    expect(r.baselines_version).toBe("old");
    expect(r.baseline_status).toBe("estimated");
    assertFlat(r);
  });
  it("differs between frozen and current when baselines changed", () => {
    const changed: RowCtx = { ...ctx, baselineFn: () => ({ minutes: 10, source: "env", estimated: false }) };
    const r = dailyRow(changed, "2026-09-10", entity());
    expect(r.cost_saved).toBe(6.0);
    expect(r.cost_saved_current).toBe(22.5); // 3 execs × 10 min = 0.5 h × 45
  });
  it("tolerates rows written by the old aggregator (missing new columns)", () => {
    const r = dailyRow(ctx, "2026-09-10", entity({ turnsSubstantive: undefined, latencySampleN: undefined, baselinesVersion: undefined, baselineStatus: undefined }));
    expect(r.turns_substantive).toBeNull();
    expect(r.latency_sample_n).toBeNull();
    expect(r.baselines_version).toBeNull();
    assertFlat(r);
  });
});

describe("toolDailyRows", () => {
  it("expands toolCounts and skips zero counts", () => {
    const rows = toolDailyRows(ctx, "2026-09-10", entity({ toolCounts: JSON.stringify({ list_departments: 2, create_employee: 0 }) }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row_id: "2026-09-10|list_departments", executions: 2, minutes_saved: 4, hours_saved: 0.07, cost_saved: 3, baseline_source: "catalog", baseline_estimated: false, category: "read" });
    rows.forEach(assertFlat);
  });
  it("returns nothing for a missing entity", () => {
    expect(toolDailyRows(ctx, "2026-09-10", null)).toEqual([]);
  });
});

describe("topicsDailyRows", () => {
  it("applies the sensitive-topic floor and leaves other topics exact", () => {
    const rows = topicsDailyRows(ctx, "2026-09-10", entity(), 5);
    const by = Object.fromEntries(rows.map((r) => [r.topic, r]));
    expect(by.holiday.turns).toBe(6);
    expect(by.holiday.answered_ok).toBe(5);
    expect(by.holiday.suppressed).toBe(false);
    expect(by.wellbeing.turns).toBeNull(); // 2 < 5
    expect(by.wellbeing.answered_ok).toBeNull();
    expect(by.wellbeing.suppressed).toBe(true);
    expect(by.conduct_grievance.turns).toBe(6); // ≥ floor stays exact
    expect(by.conduct_grievance.deflected).toBe(5);
    rows.forEach(assertFlat);
  });
  it("returns nothing for rows without topicCounts", () => {
    expect(topicsDailyRows(ctx, "2026-09-10", entity({ topicCounts: undefined }))).toEqual([]);
  });
});

describe("monthlyRow", () => {
  it("reproduces the dashboard hero_metrics formulas on a fixture", () => {
    // Hand-computed expectation (mirrors dashboardApi summary):
    // day1: 10 turns, 8 success, avg 1200, p95 3000, tools {ld:2, hb:1}
    // day2: 20 turns, 10 success, avg 800, p95 5000, tools {ld:3}
    // day3: 0 turns (quiet), avg 0 (excluded from latency mean)
    const days = [
      entity({ rowKey: "2026-09-01" }),
      entity({ rowKey: "2026-09-02", totalTurns: 20, successCount: 10, avgLatencyMs: 800, p95LatencyMs: 5000, latencySampleN: 20, toolCounts: JSON.stringify({ list_departments: 3 }), totalToolExecutions: 3, employeeTurns: 20, adminTurns: 0, costSaved: 4.5, hoursSaved: 0.1 }),
      entity({ rowKey: "2026-09-03", totalTurns: 0, successCount: 0, errorCount: 0, emptyReplyCount: 0, avgLatencyMs: 0, p95LatencyMs: 0, latencySampleN: 0, toolCounts: "{}", totalToolExecutions: 0, employeeTurns: 0, adminTurns: 0, costSaved: 0, hoursSaved: 0, uniqueUsers: 0 }),
    ];
    const r = monthlyRow(ctx, { month: "2026-09", entities: days, uniqueUsers: 9, hasTurnData: true, now: new Date("2026-09-16T00:00:00Z") });
    expect(r.total_conversations).toBe(30);
    expect(r.total_tool_executions).toBe(6);
    expect(r.self_service_rate).toBe(60); // 18/30 → 60.00 %
    expect(r.error_rate).toBe(40);
    expect(r.avg_latency_ms).toBe(1000); // mean of non-zero daily averages (1200, 800)
    expect(r.avg_latency_ms_weighted).toBe(933); // (1200×10 + 800×20) / 30
    expect(r.p95_latency_ms).toBe(5000);
    expect(r.unique_users).toBe(9);
    expect(r.unique_users_exact).toBe(true);
    // tools: ld 5 × 2 min + hb 1 × 4 min = 14 min = 0.2333 h → 0.23 h, £10.5
    expect(r.hours_saved).toBe(0.23);
    expect(r.cost_saved).toBe(10.5);
    expect(r.projected_annual_savings).toBe(126);
    expect(r.cost_saved_frozen).toBe(10.5);
    expect(r.employee_turns).toBe(27);
    expect(r.admin_turns).toBe(3);
    expect(r.is_complete_month).toBe(false);
    expect(r.days_in_month).toBe(30);
    expect(r.days_aggregated).toBe(3);
    expect(r.baseline_status).toBe("estimated");
    assertFlat(r);
  });
  it("falls back to max daily uniques when the exact scan is unavailable", () => {
    const r = monthlyRow(ctx, { month: "2026-08", entities: [entity({ rowKey: "2026-08-01", uniqueUsers: 4 }), entity({ rowKey: "2026-08-02", uniqueUsers: 7 })], uniqueUsers: null, hasTurnData: true, now: new Date("2026-09-16T00:00:00Z") });
    expect(r.unique_users).toBe(7);
    expect(r.unique_users_exact).toBe(false);
    expect(r.is_complete_month).toBe(true);
  });
});

describe("catalogRows", () => {
  it("marks estimated and env-only tools", () => {
    const rows = catalogRows(ctx, ["get_my_holiday_balance", "legacy_tool"], (t) => (t === "legacy_tool" ? { baseline: null, write: null } : { baseline: 4, write: false }));
    expect(rows[0]).toMatchObject({ tool: "get_my_holiday_balance", baseline_estimated: true, in_catalog: true, is_write: false });
    expect(rows[1]).toMatchObject({ tool: "legacy_tool", in_catalog: false, is_write: null, catalog_baseline_minutes: null });
    rows.forEach(assertFlat);
  });
});

describe("privacy", () => {
  it("no row type ever carries payload, error_message, user_hash, question or answer", () => {
    const m = computeDayMetrics({
      turns: [{ outcome: "success", user_hash: "h1", error_message: "secret", latency_total_ms: 5, agent_type: "employee", topic: "holiday", answer_coverage: "answered" }],
      toolExecs: [{ tool_name: "list_departments", error_message: "boom" }],
      rate: 45,
      baselineFn: () => 2,
      baselineEstimatedFn: () => false,
      baselinesVersion: "v",
    });
    const e = metricsEntity("t1", "2026-09-10", m, "2026-09-11T00:00:00Z");
    const all = [dailyRow(ctx, "2026-09-10", e), ...toolDailyRows(ctx, "2026-09-10", e), ...topicsDailyRows(ctx, "2026-09-10", e), monthlyRow(ctx, { month: "2026-09", entities: [e], uniqueUsers: 1, hasTurnData: true, now: new Date() })];
    for (const r of all) {
      assertFlat(r);
      const text = JSON.stringify(r);
      expect(text).not.toMatch(/secret|boom|h1|payload|error_message|user_hash|question|answer"/);
    }
  });
});
