import { describe, expect, it } from "vitest";
import { baselineForTool, baselineMinutesForTool, baselinesVersion, categoryWithSource, getHandbookBaselines, hourlyRate, knownToolNames } from "../src/baselines";

describe("baseline precedence", () => {
  it("env override > catalog > legacy > 3-minute floor", () => {
    const handbook = { list_departments: 9 };
    expect(baselineForTool("list_departments", { handbook })).toEqual({ minutes: 9, source: "env", estimated: false });
    expect(baselineForTool("list_departments", { handbook: {} })).toEqual({ minutes: 2, source: "catalog", estimated: false });
    expect(baselineForTool("get_employee_details", { handbook: {} })).toEqual({ minutes: 3, source: "legacy", estimated: false }); // pre-rename name
    expect(baselineForTool("never_heard_of_it", { handbook: {} })).toEqual({ minutes: 3, source: "default", estimated: false });
    expect(baselineForTool("get_my_holiday_balance", { handbook: {} }).estimated).toBe(true);
    expect(baselineMinutesForTool("create_employee", { handbook: {} })).toBe(15);
  });
  it("parses the handbook override defensively", () => {
    expect(getHandbookBaselines(undefined)).toEqual({});
    expect(getHandbookBaselines("{bad")).toEqual({});
    expect(getHandbookBaselines('{"a": 5, "b": "x", "c": -1, "d": "7"}')).toEqual({ a: 5, d: 7 });
  });
  it("categorises from the catalog, then by prefix", () => {
    expect(categoryWithSource("approve_leave_request")).toEqual({ category: "policy", source: "catalog" });
    expect(categoryWithSource("create_something_new")).toEqual({ category: "write", source: "heuristic" });
    expect(categoryWithSource("resolve_employee_id")).toEqual({ category: "resolver", source: "heuristic" });
    expect(categoryWithSource("whatever")).toEqual({ category: "read", source: "heuristic" });
  });
  it("hourly rate defaults to 45 and ignores junk", () => {
    expect(hourlyRate(undefined)).toBe(45);
    expect(hourlyRate("25")).toBe(25);
    expect(hourlyRate("0")).toBe(45);
    expect(hourlyRate("abc")).toBe(45);
  });
  it("version changes when any assumption changes, and is stable otherwise", () => {
    const a = baselinesVersion({ handbook: {}, rate: 45 });
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(baselinesVersion({ handbook: {}, rate: 45 })).toBe(a);
    expect(baselinesVersion({ handbook: {}, rate: 50 })).not.toBe(a);
    expect(baselinesVersion({ handbook: { list_departments: 9 }, rate: 45 })).not.toBe(a);
  });
  it("knows every catalog, env and legacy tool", () => {
    const names = knownToolNames({ handbook: { brand_new_tool: 1 } });
    expect(names).toContain("find_colleague");
    expect(names).toContain("get_employee_details");
    expect(names).toContain("brand_new_tool");
    expect(names).toEqual([...names].sort());
  });
});
