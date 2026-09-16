// handlers.ts — one function per BI table, plus the shared envelope and the
// pipeline block that every response carries so a consumer never mistakes a
// dead pipeline for a quiet day.

import { TOOL_CATALOG } from "../toolCatalog";
import { knownToolNames } from "../baselines";
import type { MetricsStore, EventsStore } from "./store";
import {
  type BiTable,
  type Cursor,
  BiError,
  decodeCursor,
  encodeCursor,
  nextUrl,
  pageByRowId,
  parseLimit,
  resolveDayWindow,
  resolveMonthWindow,
} from "./query";
import { type FlatRow, type RowCtx, catalogRows, dailyRow, monthlyRow, toolDailyRows, topicsDailyRows, DEFAULT_SENSITIVE_FLOOR } from "./rows";
import { addDays, eachDay, eachMonth, daysInMonth, isoDate, isoMonth } from "./util";

export const API_VERSION = "v1";
export const DEFAULT_STALE_HOURS = 72;

export interface BiContext extends RowCtx {
  keyId: string;
  label: string;
  metrics: MetricsStore;
  events: EventsStore;
  now: Date;
  deadlineMs: number;
  requestUrl: string;
  publicBase?: string;
  requestId: string;
  staleHours: number;
  sensitiveFloor?: number;
}

export interface PipelineMeta {
  ok: boolean;
  aggregation_ok: boolean;
  last_event_at: string | null;
  last_turn_at: string | null;
  last_aggregated_date: string | null;
  event_age_hours: number | null;
  stale_after_hours: number;
}

export interface Envelope {
  data: FlatRow[];
  next: string | null;
  meta: Record<string, unknown>;
}

export async function pipelineMeta(ctx: BiContext): Promise<PipelineMeta> {
  const newest = await ctx.events.newestEvent(ctx.tenantId);
  const newestTurn = newest ? await ctx.events.newestTurn(ctx.tenantId) : null;
  const today = isoDate(ctx.now);
  const lastAgg = await ctx.metrics.latestDate(ctx.tenantId, addDays(today, -14));
  const ageHours = newest?.timestamp ? Math.round(((ctx.now.getTime() - new Date(newest.timestamp).getTime()) / 3600000) * 10) / 10 : null;
  const yesterday = addDays(today, -1);
  return {
    ok: ageHours !== null && ageHours <= ctx.staleHours,
    aggregation_ok: lastAgg !== null && lastAgg >= addDays(yesterday, -1),
    last_event_at: newest?.timestamp || null,
    last_turn_at: newestTurn?.timestamp || null,
    last_aggregated_date: lastAgg,
    event_age_hours: ageHours,
    stale_after_hours: ctx.staleHours,
  };
}

function baseMeta(ctx: BiContext, table: BiTable, pipeline: PipelineMeta, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    table,
    api_version: API_VERSION,
    tenant_id: ctx.tenantId,
    key_id: ctx.keyId,
    timezone: "UTC",
    currency: ctx.currency ?? "GBP",
    hourly_rate: ctx.rate,
    baselines_version: ctx.baselinesVersion,
    generated_at: ctx.now.toISOString(),
    request_id: ctx.requestId,
    cached: false,
    pipeline,
    warnings: [],
    ...extra,
  };
}

function paged(
  ctx: BiContext,
  table: BiTable,
  rows: FlatRow[],
  q: URLSearchParams,
  window: { from: string; to: string },
  cursorRaw: string | null
): { data: FlatRow[]; next: string | null; limit: number } {
  const limit = parseLimit(q.get("limit"));
  const after = cursorRaw ? decodeCursor(cursorRaw, { table, tenantId: ctx.tenantId, from: window.from, to: window.to }).after : null;
  rows.sort((a, b) => (a.row_id < b.row_id ? -1 : a.row_id > b.row_id ? 1 : 0));
  const { page, nextAfter } = pageByRowId(rows, after, limit);
  let next: string | null = null;
  if (nextAfter !== null) {
    const c: Cursor = { v: 1, t: table, tid: ctx.tenantId, from: window.from, to: window.to, after: nextAfter };
    next = nextUrl(ctx.requestUrl, ctx.publicBase, encodeCursor(c));
  }
  return { data: page, next, limit };
}

async function metricsByDate(ctx: BiContext, from: string, to: string): Promise<Map<string, any>> {
  const rows = await ctx.metrics.listRange(ctx.tenantId, from, to);
  const m = new Map<string, any>();
  for (const r of rows) m.set(String(r.rowKey), r);
  return m;
}

// ── tables ────────────────────────────────────────────────────────────────────

export async function health(ctx: BiContext, _q: URLSearchParams): Promise<Envelope> {
  const p = await pipelineMeta(ctx);
  const status = p.last_event_at === null ? "no_data" : p.ok && p.aggregation_ok ? "ok" : "degraded";
  const row: FlatRow = {
    row_id: "health",
    tenant_id: ctx.tenantId,
    status,
    pipeline_ok: p.ok,
    aggregation_ok: p.aggregation_ok,
    last_event_at: p.last_event_at,
    last_turn_at: p.last_turn_at,
    last_aggregated_date: p.last_aggregated_date,
    event_age_hours: p.event_age_hours,
    stale_after_hours: p.stale_after_hours,
    hourly_rate: ctx.rate,
    currency: ctx.currency ?? "GBP",
    api_version: API_VERSION,
    checked_at: ctx.now.toISOString(),
  };
  return { data: [row], next: null, meta: baseMeta(ctx, "health", p, { count: 1 }) };
}

export async function daily(ctx: BiContext, q: URLSearchParams): Promise<Envelope> {
  const w = resolveDayWindow(q, ctx.now);
  const byDate = await metricsByDate(ctx, w.from, w.to);
  const rows: FlatRow[] = [];
  const missing: string[] = [];
  for (const d of eachDay(w.from, w.to)) {
    const e = byDate.get(d) ?? null;
    if (!e) missing.push(d);
    rows.push(dailyRow(ctx, d, e));
  }
  const pg = paged(ctx, "daily", rows, q, w, q.get("cursor"));
  const p = await pipelineMeta(ctx);
  return {
    data: pg.data,
    next: pg.next,
    meta: baseMeta(ctx, "daily", p, { from: w.from, to: w.to, limit: pg.limit, count: pg.data.length, missing_days: missing, warnings: w.warnings }),
  };
}

export async function toolDaily(ctx: BiContext, q: URLSearchParams): Promise<Envelope> {
  const w = resolveDayWindow(q, ctx.now);
  const byDate = await metricsByDate(ctx, w.from, w.to);
  const rows: FlatRow[] = [];
  const missing: string[] = [];
  for (const d of eachDay(w.from, w.to)) {
    const e = byDate.get(d);
    if (!e) {
      missing.push(d);
      continue;
    }
    rows.push(...toolDailyRows(ctx, d, e));
  }
  const pg = paged(ctx, "tool_daily", rows, q, w, q.get("cursor"));
  const p = await pipelineMeta(ctx);
  return {
    data: pg.data,
    next: pg.next,
    meta: baseMeta(ctx, "tool_daily", p, { from: w.from, to: w.to, limit: pg.limit, count: pg.data.length, missing_days: missing, warnings: w.warnings }),
  };
}

export async function topicsDaily(ctx: BiContext, q: URLSearchParams): Promise<Envelope> {
  const w = resolveDayWindow(q, ctx.now);
  const byDate = await metricsByDate(ctx, w.from, w.to);
  const rows: FlatRow[] = [];
  const missing: string[] = [];
  const floor = ctx.sensitiveFloor ?? DEFAULT_SENSITIVE_FLOOR;
  for (const d of eachDay(w.from, w.to)) {
    const e = byDate.get(d);
    if (!e) {
      missing.push(d);
      continue;
    }
    rows.push(...topicsDailyRows(ctx, d, e, floor));
  }
  const pg = paged(ctx, "topics_daily", rows, q, w, q.get("cursor"));
  const p = await pipelineMeta(ctx);
  return {
    data: pg.data,
    next: pg.next,
    meta: baseMeta(ctx, "topics_daily", p, {
      from: w.from,
      to: w.to,
      limit: pg.limit,
      count: pg.data.length,
      missing_days: missing,
      sensitive_floor: floor,
      warnings: w.warnings,
    }),
  };
}

export async function monthly(ctx: BiContext, q: URLSearchParams): Promise<Envelope> {
  const w = resolveMonthWindow(q, ctx.now);
  const warnings = [...w.warnings];
  const firstDay = `${w.from}-01`;
  const lastDay = `${w.to}-${String(daysInMonth(w.to)).padStart(2, "0")}`;
  const all = await ctx.metrics.listRange(ctx.tenantId, firstDay, lastDay);
  const byMonth = new Map<string, any[]>();
  for (const e of all) {
    const m = String(e.rowKey).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(e);
  }
  const rows: FlatRow[] = [];
  const started = Date.now();
  for (const m of eachMonth(w.from, w.to)) {
    const entities = byMonth.get(m) ?? [];
    const hasTurnData = entities.some((e) => (e.totalTurns as number) > 0);
    let unique: number | null = null;
    if (entities.length > 0) {
      const remaining = ctx.deadlineMs - (Date.now() - started);
      if (remaining > 0) {
        const mStart = `${m}-01`;
        const mEnd = `${m}-${String(daysInMonth(m)).padStart(2, "0")}`;
        const r = await ctx.events.userHashesInRange(ctx.tenantId, mStart, mEnd, remaining);
        if (r.complete) unique = r.hashes.size;
        else warnings.push(`unique_users for ${m} fell back to max daily uniques (scan deadline)`);
      } else {
        warnings.push(`unique_users for ${m} fell back to max daily uniques (scan deadline)`);
      }
    } else {
      unique = 0;
    }
    rows.push(monthlyRow(ctx, { month: m, entities, uniqueUsers: unique, hasTurnData, now: ctx.now }));
  }
  const pg = paged(ctx, "monthly", rows, q, w, q.get("cursor"));
  const p = await pipelineMeta(ctx);
  return {
    data: pg.data,
    next: pg.next,
    meta: baseMeta(ctx, "monthly", p, { from: w.from, to: w.to, limit: pg.limit, count: pg.data.length, warnings }),
  };
}

export async function toolCatalog(ctx: BiContext, _q: URLSearchParams): Promise<Envelope> {
  const rows = catalogRows(ctx, knownToolNames(), (tool) => {
    const e = TOOL_CATALOG[tool];
    return { baseline: e ? e.baseline_minutes : null, write: e ? e.write : null };
  });
  rows.sort((a, b) => (a.row_id < b.row_id ? -1 : 1));
  const p = await pipelineMeta(ctx);
  return { data: rows, next: null, meta: baseMeta(ctx, "tool_catalog", p, { count: rows.length, current_month: isoMonth(ctx.now) }) };
}

export async function handleTable(table: BiTable, q: URLSearchParams, ctx: BiContext): Promise<Envelope> {
  switch (table) {
    case "health":
      return health(ctx, q);
    case "daily":
      return daily(ctx, q);
    case "tool_daily":
      return toolDaily(ctx, q);
    case "topics_daily":
      return topicsDaily(ctx, q);
    case "monthly":
      return monthly(ctx, q);
    case "tool_catalog":
      return toolCatalog(ctx, q);
    default:
      throw new BiError(404, "unknown_table", `unknown table ${String(table)}`);
  }
}
