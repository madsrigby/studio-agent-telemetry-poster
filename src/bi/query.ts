// query.ts — request validation, date windows, cursors and next links for the
// BI API. Pure functions; every failure is a BiError with a stable code.

import { addDays, addMonths, daysBetweenInclusive, eachMonth, isoDate, isoMonth } from "./util";

export const TABLES = ["health", "daily", "tool_daily", "topics_daily", "monthly", "tool_catalog"] as const;
export type BiTable = (typeof TABLES)[number];

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;
export const MAX_DAY_WINDOW = 366;
export const DEFAULT_DAY_WINDOW = 30;
export const MAX_MONTH_WINDOW = 24;
export const DEFAULT_MONTH_WINDOW = 12;

export class BiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public param?: string
  ) {
    super(message);
  }
}

export function isTable(s: string): s is BiTable {
  return (TABLES as readonly string[]).includes(s);
}

/** OData string literal escaping: a single quote is doubled. */
export function odataString(s: string): string {
  return s.replace(/'/g, "''");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function parseDate(s: string | null, param: string): string | null {
  if (s === null || s === undefined || s === "") return null;
  if (!DATE_RE.test(s)) throw new BiError(400, "invalid_param", `${param} must be YYYY-MM-DD`, param);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || isoDate(d) !== s) throw new BiError(400, "invalid_param", `${param} is not a real date`, param);
  return s;
}

export function parseMonth(s: string | null, param: string): string | null {
  if (s === null || s === undefined || s === "") return null;
  if (!MONTH_RE.test(s)) throw new BiError(400, "invalid_param", `${param} must be YYYY-MM`, param);
  const d = new Date(`${s}-01T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || isoMonth(d) !== s) throw new BiError(400, "invalid_param", `${param} is not a real month`, param);
  return s;
}

export function parseLimit(s: string | null): number {
  if (s === null || s === undefined || s === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(s)) throw new BiError(400, "invalid_param", "limit must be an integer", "limit");
  const n = parseInt(s, 10);
  if (n < 1 || n > MAX_LIMIT) throw new BiError(400, "invalid_param", `limit must be between 1 and ${MAX_LIMIT}`, "limit");
  return n;
}

export interface DayWindow {
  from: string;
  to: string;
  warnings: string[];
}

/** Daily tables: default last 30 complete days; `to` never later than yesterday (UTC). */
export function resolveDayWindow(q: URLSearchParams, now: Date): DayWindow {
  const warnings: string[] = [];
  const yesterday = addDays(isoDate(now), -1);
  let to = parseDate(q.get("to"), "to");
  let from = parseDate(q.get("from"), "from");
  if (to === null) to = yesterday;
  if (to > yesterday) {
    warnings.push(`to clamped to yesterday (${yesterday}): today is not aggregated yet`);
    to = yesterday;
  }
  if (from === null) from = addDays(to, -(DEFAULT_DAY_WINDOW - 1));
  if (from > to) throw new BiError(400, "invalid_param", "from must not be after to", "from");
  const span = daysBetweenInclusive(from, to);
  if (span > MAX_DAY_WINDOW) throw new BiError(400, "invalid_param", `window must be at most ${MAX_DAY_WINDOW} days`, "from");
  return { from, to, warnings };
}

/** Monthly table: default last 12 months including the current one. */
export function resolveMonthWindow(q: URLSearchParams, now: Date): DayWindow {
  const warnings: string[] = [];
  const current = isoMonth(now);
  let to = parseMonth(q.get("to"), "to");
  let from = parseMonth(q.get("from"), "from");
  if (to === null) to = current;
  if (to > current) {
    warnings.push(`to clamped to the current month (${current})`);
    to = current;
  }
  if (from === null) from = addMonths(to, -(DEFAULT_MONTH_WINDOW - 1));
  if (from > to) throw new BiError(400, "invalid_param", "from must not be after to", "from");
  if (eachMonth(from, to).length > MAX_MONTH_WINDOW) {
    throw new BiError(400, "invalid_param", `window must be at most ${MAX_MONTH_WINDOW} months`, "from");
  }
  return { from, to, warnings };
}

export interface Cursor {
  v: 1;
  t: BiTable;
  tid: string;
  from: string;
  to: string;
  after: string; // last emitted row_id
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

export function encodeCursor(c: Cursor): string {
  return b64url(JSON.stringify(c));
}

export function decodeCursor(raw: string, expect: { table: BiTable; tenantId: string; from: string; to: string }): Cursor {
  let c: any;
  try {
    c = JSON.parse(unb64url(raw));
  } catch {
    throw new BiError(400, "invalid_cursor", "cursor is not decodable", "cursor");
  }
  if (!c || c.v !== 1 || typeof c.after !== "string") throw new BiError(400, "invalid_cursor", "cursor has the wrong shape", "cursor");
  if (c.t !== expect.table || c.tid !== expect.tenantId || c.from !== expect.from || c.to !== expect.to) {
    throw new BiError(400, "invalid_cursor", "cursor does not belong to this query", "cursor");
  }
  return c as Cursor;
}

/** Same URL with the cursor replaced; origin overridable for a custom domain. */
export function nextUrl(requestUrl: string, publicBase: string | undefined, cursor: string): string {
  const u = new URL(requestUrl);
  u.searchParams.set("cursor", cursor);
  if (publicBase) {
    const base = new URL(publicBase);
    u.protocol = base.protocol;
    u.host = base.host;
  }
  return u.toString();
}

/** Deterministic cache key: sorted query params. */
export function canonicalQuery(q: URLSearchParams): string {
  const entries = Array.from(q.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Page an already-sorted array by row_id. Returns the slice and the row_id to
 * resume from, or null when exhausted.
 */
export function pageByRowId<T extends { row_id: string }>(rows: T[], after: string | null, limit: number): { page: T[]; nextAfter: string | null } {
  let start = 0;
  if (after !== null) {
    start = rows.findIndex((r) => r.row_id > after);
    if (start === -1) return { page: [], nextAfter: null };
  }
  const page = rows.slice(start, start + limit);
  const nextAfter = start + limit < rows.length ? page[page.length - 1].row_id : null;
  return { page, nextAfter };
}
