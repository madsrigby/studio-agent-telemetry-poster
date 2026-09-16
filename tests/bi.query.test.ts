import { describe, expect, it } from "vitest";
import {
  BiError,
  canonicalQuery,
  decodeCursor,
  encodeCursor,
  nextUrl,
  odataString,
  pageByRowId,
  parseDate,
  parseLimit,
  parseMonth,
  resolveDayWindow,
  resolveMonthWindow,
} from "../src/bi/query";
import { dayRowKeyBounds } from "../src/aggregation/aggregateDay";
import { invertedTs } from "../src/bi/util";

const NOW = new Date("2026-09-16T10:30:00.000Z");
const q = (s: string) => new URLSearchParams(s);
const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as BiError;
  }
  throw new Error("expected throw");
};

describe("odataString", () => {
  it("doubles single quotes", () => {
    expect(odataString("O'Brien")).toBe("O''Brien");
    expect(odataString("x' or PartitionKey ne 'x")).toBe("x'' or PartitionKey ne ''x");
  });
});

describe("date parsing", () => {
  it("accepts real dates and rejects bad ones", () => {
    expect(parseDate("2026-02-28", "from")).toBe("2026-02-28");
    expect(parseDate(null, "from")).toBeNull();
    expect(err(() => parseDate("2026-2-1", "from")).code).toBe("invalid_param");
    expect(err(() => parseDate("2026-02-31", "from")).code).toBe("invalid_param");
    expect(err(() => parseDate("2026-13-01", "to")).param).toBe("to");
    expect(parseMonth("2026-09", "from")).toBe("2026-09");
    expect(err(() => parseMonth("2026-13", "from")).code).toBe("invalid_param");
  });
  it("limit bounds", () => {
    expect(parseLimit(null)).toBe(500);
    expect(parseLimit("1000")).toBe(1000);
    expect(err(() => parseLimit("0")).code).toBe("invalid_param");
    expect(err(() => parseLimit("1001")).code).toBe("invalid_param");
    expect(err(() => parseLimit("ten")).code).toBe("invalid_param");
  });
});

describe("resolveDayWindow", () => {
  it("defaults to the last 30 complete days ending yesterday", () => {
    const w = resolveDayWindow(q(""), NOW);
    expect(w).toEqual({ from: "2026-08-17", to: "2026-09-15", warnings: [] });
  });
  it("clamps to yesterday with a warning", () => {
    const w = resolveDayWindow(q("from=2026-09-10&to=2026-09-16"), NOW);
    expect(w.to).toBe("2026-09-15");
    expect(w.warnings[0]).toMatch(/clamped to yesterday/);
  });
  it("rejects from after to and windows over 366 days", () => {
    expect(err(() => resolveDayWindow(q("from=2026-09-10&to=2026-09-01"), NOW)).code).toBe("invalid_param");
    expect(err(() => resolveDayWindow(q("from=2025-01-01&to=2026-09-01"), NOW)).message).toMatch(/366/);
    expect(resolveDayWindow(q("from=2025-09-15&to=2026-09-15"), NOW).from).toBe("2025-09-15");
  });
});

describe("resolveMonthWindow", () => {
  it("defaults to 12 months including the current one", () => {
    expect(resolveMonthWindow(q(""), NOW)).toEqual({ from: "2025-10", to: "2026-09", warnings: [] });
  });
  it("caps at 24 months and clamps future months", () => {
    expect(err(() => resolveMonthWindow(q("from=2024-01&to=2026-09"), NOW)).code).toBe("invalid_param");
    const w = resolveMonthWindow(q("to=2027-01"), NOW);
    expect(w.to).toBe("2026-09");
    expect(w.warnings).toHaveLength(1);
  });
});

describe("inverted row keys", () => {
  it("are 13 chars, zero padded, and match the aggregation bounds", () => {
    const b = dayRowKeyBounds("2026-09-15");
    expect(b.rowKeyGe).toHaveLength(13);
    expect(b.rowKeyLe).toHaveLength(13);
    expect(b.rowKeyGe < b.rowKeyLe).toBe(true); // later instant → smaller key
    expect(b.rowKeyLe).toBe(invertedTs(new Date("2026-09-15T00:00:00.000Z").getTime()));
  });
});

describe("cursor", () => {
  const expect_ = { table: "daily" as const, tenantId: "t1", from: "2026-09-01", to: "2026-09-15" };
  it("round-trips", () => {
    const c = encodeCursor({ v: 1, t: "daily", tid: "t1", from: "2026-09-01", to: "2026-09-15", after: "2026-09-05" });
    expect(c).not.toMatch(/[+/=]/);
    expect(decodeCursor(c, expect_).after).toBe("2026-09-05");
  });
  it("rejects garbage and cursors from another query", () => {
    expect(err(() => decodeCursor("garbage", expect_)).code).toBe("invalid_cursor");
    const other = encodeCursor({ v: 1, t: "daily", tid: "t2", from: "2026-09-01", to: "2026-09-15", after: "x" });
    expect(err(() => decodeCursor(other, expect_)).code).toBe("invalid_cursor");
    const otherWindow = encodeCursor({ v: 1, t: "daily", tid: "t1", from: "2026-09-02", to: "2026-09-15", after: "x" });
    expect(err(() => decodeCursor(otherWindow, expect_)).code).toBe("invalid_cursor");
    const otherTable = encodeCursor({ v: 1, t: "monthly", tid: "t1", from: "2026-09-01", to: "2026-09-15", after: "x" });
    expect(err(() => decodeCursor(otherTable, expect_)).code).toBe("invalid_cursor");
  });
});

describe("nextUrl", () => {
  it("keeps params, replaces cursor, honours a public base", () => {
    const u = nextUrl("https://x.azurewebsites.net/api/v1/bi/daily?from=2026-09-01&limit=5&cursor=old", undefined, "new");
    expect(u).toBe("https://x.azurewebsites.net/api/v1/bi/daily?from=2026-09-01&limit=5&cursor=new");
    const v = nextUrl("https://x.azurewebsites.net/api/v1/bi/daily?limit=5", "https://api.example.com", "c");
    expect(v).toBe("https://api.example.com/api/v1/bi/daily?limit=5&cursor=c");
  });
});

describe("canonicalQuery + pageByRowId", () => {
  it("sorts params", () => {
    expect(canonicalQuery(q("to=b&from=a"))).toBe("from=a&to=b");
  });
  it("pages after a row id and terminates", () => {
    const rows = ["a", "b", "c", "d", "e"].map((row_id) => ({ row_id }));
    const p1 = pageByRowId(rows, null, 2);
    expect(p1.page.map((r) => r.row_id)).toEqual(["a", "b"]);
    expect(p1.nextAfter).toBe("b");
    const p2 = pageByRowId(rows, "b", 2);
    expect(p2.page.map((r) => r.row_id)).toEqual(["c", "d"]);
    const p3 = pageByRowId(rows, "d", 2);
    expect(p3.page.map((r) => r.row_id)).toEqual(["e"]);
    expect(p3.nextAfter).toBeNull();
    expect(pageByRowId(rows, "e", 2)).toEqual({ page: [], nextAfter: null });
  });
});
