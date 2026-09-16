import { describe, expect, it } from "vitest";
import { type BiContext, handleTable, pipelineMeta } from "../src/bi/handlers";
import type { EventsStore, MetricsStore } from "../src/bi/store";
import { BiError, decodeCursor } from "../src/bi/query";
import { computeDayMetrics, metricsEntity } from "../src/aggregation/aggregateDay";
import { assertFlat } from "../src/bi/rows";

const NOW = new Date("2026-09-16T10:00:00.000Z");
const TENANT = "t1";

function day(date: string, turns: number, tools: Record<string, number> = {}) {
  const t = Array.from({ length: turns }, (_, i) => ({ event_type: "turn_completed", outcome: i === 0 && turns > 1 ? "error" : "success", user_hash: `u${i % 3}`, latency_total_ms: 500 + i, agent_type: "employee", topic: i % 2 ? "holiday" : "wellbeing", answer_coverage: "answered" }));
  const x: any[] = [];
  for (const [name, n] of Object.entries(tools)) for (let i = 0; i < n; i++) x.push({ event_type: "tool_executed", tool_name: name });
  const m = computeDayMetrics({ turns: t, toolExecs: x, rate: 45, baselineFn: () => 2, baselineEstimatedFn: () => false, baselinesVersion: "v1" });
  return metricsEntity(TENANT, date, m, "2026-09-16T02:00:00.000Z");
}

function fakeMetrics(rows: any[]): MetricsStore {
  return {
    async listRange(tenantId, fromKey, toKey) {
      return rows.filter((r) => r.partitionKey === tenantId && r.rowKey >= fromKey && r.rowKey <= toKey);
    },
    async latestDate(tenantId, sinceKey) {
      const keys = rows.filter((r) => r.partitionKey === tenantId && r.rowKey >= sinceKey).map((r) => r.rowKey as string);
      return keys.length ? keys.sort().pop()! : null;
    },
    async tenants() {
      return Array.from(new Set(rows.map((r) => r.partitionKey)));
    },
    async upsert() {},
  };
}

function fakeEvents(opts: { newest?: string | null; newestTurn?: string | null; hashes?: string[]; slow?: boolean }): EventsStore {
  return {
    async newestEvent() {
      return opts.newest ? { timestamp: opts.newest, eventType: "turn_completed" } : null;
    },
    async newestTurn() {
      return opts.newestTurn ? { timestamp: opts.newestTurn } : null;
    },
    async userHashesInRange(_t, _f, _to, deadlineMs) {
      if (opts.slow) return { hashes: new Set<string>(), complete: false };
      void deadlineMs;
      return { hashes: new Set(opts.hashes ?? []), complete: true };
    },
    async *scanEvents() {},
  };
}

function ctx(over: Partial<BiContext> = {}): BiContext {
  return {
    tenantId: TENANT,
    keyId: "k1",
    label: "test",
    metrics: fakeMetrics([]),
    events: fakeEvents({ newest: "2026-09-15T18:00:00.000Z", newestTurn: "2026-09-15T18:00:00.000Z" }),
    now: NOW,
    rate: 45,
    baselinesVersion: "v1",
    baselineFn: () => ({ minutes: 2, source: "catalog", estimated: false }),
    categoryFn: () => ({ category: "read", source: "catalog" }),
    deadlineMs: 20_000,
    requestUrl: "https://host/api/v1/bi/daily?from=2026-09-10&to=2026-09-15",
    requestId: "req-1",
    staleHours: 72,
    ...over,
  };
}

const q = (s: string) => new URLSearchParams(s);

describe("pipelineMeta / health", () => {
  it("is ok when events are fresh and aggregation is current", async () => {
    const c = ctx({ metrics: fakeMetrics([day("2026-09-15", 1)]) });
    const p = await pipelineMeta(c);
    expect(p).toMatchObject({ ok: true, aggregation_ok: true, last_aggregated_date: "2026-09-15", event_age_hours: 16 });
    const h = await handleTable("health", q(""), c);
    expect(h.data[0].status).toBe("ok");
    assertFlat(h.data[0]);
  });
  it("is degraded when events are stale or aggregation lags", async () => {
    const stale = ctx({ metrics: fakeMetrics([day("2026-09-15", 1)]), events: fakeEvents({ newest: "2026-09-01T00:00:00.000Z" }) });
    expect((await handleTable("health", q(""), stale)).data[0].status).toBe("degraded");
    const lag = ctx({ metrics: fakeMetrics([day("2026-09-10", 1)]) });
    const h = await handleTable("health", q(""), lag);
    expect(h.data[0]).toMatchObject({ status: "degraded", pipeline_ok: true, aggregation_ok: false });
  });
  it("is no_data when the tenant has never had an event", async () => {
    const h = await handleTable("health", q(""), ctx({ events: fakeEvents({ newest: null }) }));
    expect(h.data[0]).toMatchObject({ status: "no_data", last_event_at: null, event_age_hours: null });
  });
});

describe("daily", () => {
  it("emits one row per day, missing days as null rows, and lists them in meta", async () => {
    const c = ctx({ metrics: fakeMetrics([day("2026-09-10", 3, { a: 1 }), day("2026-09-12", 0)]) });
    const env = await handleTable("daily", q("from=2026-09-10&to=2026-09-13"), c);
    expect(env.data.map((r) => [r.date, r.aggregation_status])).toEqual([
      ["2026-09-10", "complete"],
      ["2026-09-11", "missing"],
      ["2026-09-12", "complete"],
      ["2026-09-13", "missing"],
    ]);
    expect(env.meta.missing_days).toEqual(["2026-09-11", "2026-09-13"]);
    expect(env.data[0].turns).toBe(3);
    expect(env.data[2].turns).toBe(0); // quiet day ≠ missing
    expect(env.next).toBeNull();
    expect(env.meta).toMatchObject({ table: "daily", tenant_id: TENANT, timezone: "UTC", from: "2026-09-10", to: "2026-09-13", count: 4 });
    env.data.forEach(assertFlat);
  });
  it("pages with an absolute next URL whose cursor chains to the end", async () => {
    const c = ctx({ metrics: fakeMetrics([]) });
    const p1 = await handleTable("daily", q("from=2026-09-10&to=2026-09-14&limit=2"), c);
    expect(p1.data.map((r) => r.row_id)).toEqual(["2026-09-10", "2026-09-11"]);
    expect(p1.next).toMatch(/^https:\/\/host\/api\/v1\/bi\/daily\?from=2026-09-10&to=2026-09-15&cursor=/);
    const cursor = new URL(p1.next!).searchParams.get("cursor")!;
    expect(decodeCursor(cursor, { table: "daily", tenantId: TENANT, from: "2026-09-10", to: "2026-09-14" }).after).toBe("2026-09-11");
    const p2 = await handleTable("daily", q(`from=2026-09-10&to=2026-09-14&limit=2&cursor=${cursor}`), c);
    expect(p2.data.map((r) => r.row_id)).toEqual(["2026-09-12", "2026-09-13"]);
    const c3 = new URL(p2.next!).searchParams.get("cursor")!;
    const p3 = await handleTable("daily", q(`from=2026-09-10&to=2026-09-14&limit=2&cursor=${c3}`), c);
    expect(p3.data.map((r) => r.row_id)).toEqual(["2026-09-14"]);
    expect(p3.next).toBeNull();
  });
  it("clamps today with a warning", async () => {
    const env = await handleTable("daily", q("from=2026-09-15&to=2026-09-16"), ctx());
    expect(env.meta.to).toBe("2026-09-15");
    expect((env.meta.warnings as string[])[0]).toMatch(/clamped/);
  });
});

describe("tool_daily / topics_daily", () => {
  it("expands tools per day and skips missing days from rows but not from meta", async () => {
    const c = ctx({ metrics: fakeMetrics([day("2026-09-10", 2, { list_departments: 3, create_employee: 1 })]) });
    const env = await handleTable("tool_daily", q("from=2026-09-10&to=2026-09-11"), c);
    expect(env.data.map((r) => r.row_id)).toEqual(["2026-09-10|create_employee", "2026-09-10|list_departments"]);
    expect(env.meta.missing_days).toEqual(["2026-09-11"]);
    env.data.forEach(assertFlat);
  });
  it("suppresses small sensitive counts", async () => {
    const c = ctx({ metrics: fakeMetrics([day("2026-09-10", 4)]) }); // wellbeing: 2 turns, holiday: 2 turns
    const env = await handleTable("topics_daily", q("from=2026-09-10&to=2026-09-10"), c);
    const by = Object.fromEntries(env.data.map((r) => [r.topic, r]));
    expect(by.holiday.turns).toBe(2);
    expect(by.wellbeing.turns).toBeNull();
    expect(by.wellbeing.suppressed).toBe(true);
    expect(env.meta.sensitive_floor).toBe(5);
  });
});

describe("monthly", () => {
  it("uses exact uniques when the scan completes and flags the current month incomplete", async () => {
    const c = ctx({ metrics: fakeMetrics([day("2026-09-10", 3, { a: 2 }), day("2026-08-31", 1)]), events: fakeEvents({ newest: "2026-09-15T18:00:00.000Z", hashes: ["x", "y"] }) });
    const env = await handleTable("monthly", q("from=2026-08&to=2026-09"), c);
    expect(env.data.map((r) => r.month)).toEqual(["2026-08", "2026-09"]);
    expect(env.data[1]).toMatchObject({ is_complete_month: false, days_aggregated: 1, total_conversations: 3, unique_users: 2, unique_users_exact: true, cost_saved: 3 }); // 2 execs × 2 min = 4 min → £3 at £45/h
    expect(env.data[0]).toMatchObject({ is_complete_month: true, total_conversations: 1 });
    env.data.forEach(assertFlat);
  });
  it("falls back to max daily uniques with a warning when the scan hits the deadline", async () => {
    const c = ctx({ metrics: fakeMetrics([day("2026-09-10", 3)]), events: fakeEvents({ newest: "2026-09-15T18:00:00.000Z", slow: true }) });
    const env = await handleTable("monthly", q("from=2026-09&to=2026-09"), c);
    expect(env.data[0].unique_users_exact).toBe(false);
    expect(env.data[0].unique_users).toBe(3);
    expect((env.meta.warnings as string[])[0]).toMatch(/fell back/);
  });
  it("empty months are zero rows, not missing", async () => {
    const env = await handleTable("monthly", q("from=2026-07&to=2026-07"), ctx());
    expect(env.data[0]).toMatchObject({ month: "2026-07", total_conversations: 0, unique_users: 0, has_turn_data: false, days_aggregated: 0 });
  });
});

describe("tool_catalog and errors", () => {
  it("lists every known tool flat and sorted", async () => {
    const env = await handleTable("tool_catalog", q(""), ctx());
    expect(env.data.length).toBeGreaterThan(30);
    expect(env.data.map((r) => r.row_id)).toEqual([...env.data.map((r) => r.row_id)].sort());
    expect(env.data.find((r) => r.tool === "find_colleague")).toMatchObject({ in_catalog: true, baseline_estimated: false }); // ctx.baselineFn stub
    env.data.forEach(assertFlat);
  });
  it("surfaces BiError for bad params and cursors", async () => {
    await expect(handleTable("daily", q("from=2026-13-01"), ctx())).rejects.toBeInstanceOf(BiError);
    await expect(handleTable("daily", q("from=2026-09-10&to=2026-09-11&cursor=zzz"), ctx())).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(handleTable("nope" as any, q(""), ctx())).rejects.toMatchObject({ status: 404 });
  });
});
