import { describe, expect, it } from "vitest";
import { aggregateDay, aggregateRange, computeDayMetrics, dayRowKeyBounds, metricsEntity, type AggregateDeps, type RawEventRow } from "../src/aggregation/aggregateDay";
import { invertedTs } from "../src/bi/util";

const turn = (o: Record<string, unknown>) => ({ event_type: "turn_completed", outcome: "success", agent_type: "employee", latency_total_ms: 1000, user_hash: "u1", ...o });
const tool = (name: string, o: Record<string, unknown> = {}) => ({ event_type: "tool_executed", tool_name: name, ...o });

describe("computeDayMetrics", () => {
  const base = { rate: 45, baselineFn: (t: string) => (t === "list_departments" ? 2 : 4), baselineEstimatedFn: (t: string) => t === "get_my_holiday_balance", baselinesVersion: "v1" };

  it("matches the numbers the old inline aggregation produced", () => {
    // Worked example: 4 turns (3 success, 1 error), latencies 100,200,300,400 → avg 250, p95 = index ceil(4×.95)-1 = 3 → 400
    const turns = [
      turn({ latency_total_ms: 100, user_hash: "a" }),
      turn({ latency_total_ms: 200, user_hash: "b" }),
      turn({ latency_total_ms: 300, user_hash: "a", agent_type: "admin" }),
      turn({ latency_total_ms: 400, outcome: "error" }),
    ];
    const toolExecs = [tool("list_departments"), tool("list_departments"), tool("get_my_holiday_balance", { estimated_manual_minutes: 6 })];
    const m = computeDayMetrics({ turns, toolExecs, ...base });
    expect(m.totalTurns).toBe(4);
    expect(m.uniqueUsers).toBe(3);
    expect(m.successCount).toBe(3);
    expect(m.errorCount).toBe(1);
    expect(m.successRate).toBe(0.75);
    expect(m.avgLatencyMs).toBe(250);
    expect(m.p95LatencyMs).toBe(400);
    expect(m.latencySampleN).toBe(4);
    expect(m.employeeTurns).toBe(3);
    expect(m.adminTurns).toBe(1);
    expect(m.toolCounts).toEqual({ list_departments: 2, get_my_holiday_balance: 1 });
    expect(m.totalBaselineMinutes).toBe(2 + 2 + 6); // per-event estimate wins
    expect(m.hoursSaved).toBe(0.17);
    expect(m.costSaved).toBe(7.5);
    expect(m.baselineStatus).toBe("estimated");
    expect(m.baselinesVersion).toBe("v1");
  });

  it("counts substantive turns, tagging, and joins coverage with outcome", () => {
    const turns = [
      turn({ relevance_result_code: "instant_cache", topic: "other", answer_coverage: "answered" }),
      turn({ topic: "holiday", answer_coverage: "answered" }),
      turn({ topic: "holiday", answer_coverage: "answered", outcome: "error" }),
      turn({ topic: "holiday", answer_coverage: "not_in_docs" }),
      turn({ topic: "pension", answer_coverage: "made_up_value" }),
      turn({}), // pre-tagging build
    ];
    const m = computeDayMetrics({ turns, toolExecs: [], ...base });
    expect(m.turnsSubstantive).toBe(5);
    expect(m.taggedTurns).toBe(5);
    expect(m.untaggedTurns).toBe(1);
    expect(m.topicCounts.holiday).toEqual({ turns: 3, answered_ok: 1, answered_failed: 1, deflected: 0, not_in_docs: 1, escalated: 0, unknown: 0 });
    expect(m.topicCounts.pension.unknown).toBe(1);
    expect(m.topicCounts.untagged).toEqual({ turns: 1, answered_ok: 0, answered_failed: 0, deflected: 0, not_in_docs: 0, escalated: 0, unknown: 1 });
    expect(m.baselineStatus).toBe("confirmed");
  });

  it("produces a zero row for no events", () => {
    const m = computeDayMetrics({ turns: [], toolExecs: [], ...base });
    expect(m.totalTurns).toBe(0);
    expect(m.successRate).toBe(0);
    expect(m.costSaved).toBe(0);
    expect(m.topicCounts).toEqual({});
  });

  it("serialises to a flat entity with JSON columns", () => {
    const e = metricsEntity("t1", "2026-09-10", computeDayMetrics({ turns: [turn({})], toolExecs: [], ...base }), "now");
    expect(e.partitionKey).toBe("t1");
    expect(e.rowKey).toBe("2026-09-10");
    expect(typeof e.toolCounts).toBe("string");
    expect(typeof e.topicCounts).toBe("string");
    for (const v of Object.values(e)) expect(["string", "number"]).toContain(typeof v);
  });
});

function fakeDeps(events: Array<{ date: string; partitionKey: string; payload: any }>, knownTenants: string[] = []) {
  const written: any[] = [];
  const deps: AggregateDeps = {
    async *scanEvents(ge, le) {
      for (const ev of events) {
        const key = invertedTs(new Date(`${ev.date}T12:00:00.000Z`).getTime());
        if (key >= ge && key <= le) {
          const row: RawEventRow = { partitionKey: ev.partitionKey, eventType: ev.payload.event_type, payload: JSON.stringify(ev.payload) };
          yield row;
        }
      }
    },
    async upsertMetrics(e) {
      written.push(e);
    },
    knownTenants,
    rate: 45,
    baselineFn: () => 2,
    baselineEstimatedFn: () => false,
    baselinesVersion: "v1",
    log: () => {},
    now: () => new Date("2026-09-16T02:00:00Z"),
  };
  return { deps, written };
}

describe("aggregateDay / aggregateRange", () => {
  it("writes one row per tenant seen, plus zero rows for known tenants with no events", () => {
    const { deps, written } = fakeDeps(
      [
        { date: "2026-09-10", partitionKey: "t1", payload: turn({}) },
        { date: "2026-09-10", partitionKey: "t1", payload: tool("x") },
        { date: "2026-09-11", partitionKey: "t1", payload: turn({}) },
      ],
      ["t1", "t2"]
    );
    return aggregateDay("2026-09-10", deps).then((r) => {
      expect(r.tenants.sort()).toEqual(["t1", "t2"]);
      const t1 = written.find((w) => w.partitionKey === "t1");
      const t2 = written.find((w) => w.partitionKey === "t2");
      expect(t1.totalTurns).toBe(1);
      expect(t1.totalToolExecutions).toBe(1);
      expect(t2.totalTurns).toBe(0);
      expect(t2.computedAt).toBe("2026-09-16T02:00:00.000Z");
    });
  });
  it("only sees the requested day", async () => {
    const { deps, written } = fakeDeps([
      { date: "2026-09-10", partitionKey: "t1", payload: turn({}) },
      { date: "2026-09-11", partitionKey: "t1", payload: turn({}) },
      { date: "2026-09-11", partitionKey: "t1", payload: turn({}) },
    ]);
    await aggregateDay("2026-09-11", deps);
    expect(written).toHaveLength(1);
    expect(written[0].totalTurns).toBe(2);
  });
  it("aggregateRange walks every day inclusive and caps at 92", async () => {
    const { deps, written } = fakeDeps([], ["t1"]);
    const r = await aggregateRange("2026-09-01", "2026-09-03", deps);
    expect(r.days).toBe(3);
    expect(written.map((w) => w.rowKey)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    await expect(aggregateRange("2026-01-01", "2026-06-01", deps)).rejects.toThrow(/range too large/);
    await expect(aggregateRange("2026-06-02", "2026-06-01", deps)).rejects.toThrow(/empty range/);
  });
  it("day bounds are inclusive of both midnight ends", () => {
    const b = dayRowKeyBounds("2026-09-10");
    const startKey = invertedTs(new Date("2026-09-10T00:00:00.000Z").getTime());
    const endKey = invertedTs(new Date("2026-09-10T23:59:59.999Z").getTime());
    expect(startKey <= b.rowKeyLe && startKey >= b.rowKeyGe).toBe(true);
    expect(endKey <= b.rowKeyLe && endKey >= b.rowKeyGe).toBe(true);
    const next = invertedTs(new Date("2026-09-11T00:00:00.000Z").getTime());
    expect(next >= b.rowKeyGe).toBe(false);
  });
});

describe("engine verdicts (turn_outcome) and build identity", () => {
  const base = { rate: 45, baselineFn: () => 2, baselineEstimatedFn: () => false, baselinesVersion: "v1" };
  const oc = (o: Record<string, unknown>) => ({ event_type: "turn_outcome", total_tokens: 100, tool_calls: 1, tool_errors: 0, claims_kept: 3, claims_dropped: 1, ...o });

  it("counts outcomes, tokens, tool calls and claim stats; unknown outcomes go to other", () => {
    const outcomes = [oc({ outcome: "ANSWERED" }), oc({ outcome: "RETRIEVAL_MISS", claims_kept: -1, claims_dropped: -1 }), oc({ outcome: "NOT_COVERED" }), oc({ outcome: "TOOL_FAILED", tool_errors: 2 }), oc({ outcome: "WEIRD" })];
    const m = computeDayMetrics({ turns: [], toolExecs: [], outcomes, ...base });
    expect(m.outcomes.counts).toEqual({ ANSWERED: 1, NOT_COVERED: 1, RETRIEVAL_MISS: 1, TOOL_FAILED: 1, OUT_OF_SCOPE: 0, other: 1 });
    expect(m.outcomes.sampleN).toBe(5);
    expect(m.outcomes.totalTokens).toBe(500);
    expect(m.outcomes.toolCalls).toBe(5);
    expect(m.outcomes.toolErrors).toBe(2);
    expect(m.outcomes.claimsSampleN).toBe(4); // the -1 row is excluded
    expect(m.outcomes.claimsKept).toBe(12);
    expect(m.outcomes.claimsDropped).toBe(4);
  });

  it("collects distinct build shas in time order and picks the newest", () => {
    const turns = [
      turn({ build_sha: "old1", timestamp: "2026-09-10T08:00:00Z" }),
      turn({ build_sha: "new2", timestamp: "2026-09-10T12:00:00Z" }),
      turn({ build_sha: "old1", timestamp: "2026-09-10T09:00:00Z" }),
      turn({}),
    ];
    const m = computeDayMetrics({ turns, toolExecs: [], ...base });
    expect(m.buildShas).toEqual(["old1", "new2"]);
    expect(m.buildSha).toBe("new2");
    const e = metricsEntity("t1", "2026-09-10", m, "now");
    expect(JSON.parse(e.buildShas)).toEqual(["old1", "new2"]);
    expect(e.buildSha).toBe("new2");
    expect(typeof e.outcomeCounts).toBe("string");
  });

  it("old callers without outcomes get zeroed stats and an empty build sha", () => {
    const m = computeDayMetrics({ turns: [turn({})], toolExecs: [], ...base });
    expect(m.outcomes.sampleN).toBe(0);
    expect(m.buildSha).toBe("");
  });

  it("aggregateDay routes turn_outcome rows into the tenant's outcomes", async () => {
    const { deps, written } = fakeDeps([
      { date: "2026-09-10", partitionKey: "t1", payload: turn({}) },
      { date: "2026-09-10", partitionKey: "t1", payload: oc({ outcome: "RETRIEVAL_MISS" }) },
    ]);
    await aggregateDay("2026-09-10", deps);
    expect(JSON.parse(written[0].outcomeCounts).RETRIEVAL_MISS).toBe(1);
    expect(written[0].outcomeSampleN).toBe(1);
  });
});
