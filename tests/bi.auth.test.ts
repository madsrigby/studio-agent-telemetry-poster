import { describe, expect, it } from "vitest";
import { authenticate, configuredTenants, extractPresentedKey, keyEntryFor, parseKeyConfig, safeEqualHex, sha256Hex } from "../src/bi/auth";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const TENANT_A = "71418a92-c160-4b5d-8908-634d844e3bdf";
const TENANT_B = "queue-probe";

const CONFIG = JSON.stringify([
  keyEntryFor(KEY_A, "allect-k1", TENANT_A, "allect-grow"),
  keyEntryFor(KEY_B, "probe-k1", TENANT_B, "internal-probe"),
]);

function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

describe("parseKeyConfig", () => {
  it("parses a valid array of hashed entries", () => {
    const c = parseKeyConfig(CONFIG);
    expect(c).toHaveLength(2);
    expect(c[0].tenantId).toBe(TENANT_A);
    expect(c[0].sha256).toBe(sha256Hex(KEY_A));
  });
  it("fails closed on unset, empty, bad JSON, empty array, malformed entry", () => {
    expect(parseKeyConfig(undefined)).toEqual([]);
    expect(parseKeyConfig("")).toEqual([]);
    expect(parseKeyConfig("{not json")).toEqual([]);
    expect(parseKeyConfig("[]")).toEqual([]);
    expect(parseKeyConfig(JSON.stringify([{ id: "x", sha256: "nothex", tenant_id: "t" }]))).toEqual([]);
    expect(parseKeyConfig(JSON.stringify([{ id: "x", sha256: sha256Hex("k") }]))).toEqual([]);
    // one bad entry poisons the whole config — never partially open
    expect(parseKeyConfig(JSON.stringify([keyEntryFor(KEY_A, "ok", TENANT_A, "l"), { id: "bad" }]))).toEqual([]);
  });
  it("never stores the key itself", () => {
    expect(CONFIG).not.toContain(KEY_A);
  });
});

describe("extractPresentedKey", () => {
  it("prefers x-api-key", () => {
    expect(extractPresentedKey(headers({ "x-api-key": "k1", authorization: "Bearer k2" }))).toBe("k1");
  });
  it("accepts Bearer, bearer and bare Authorization values", () => {
    expect(extractPresentedKey(headers({ Authorization: "Bearer k2" }))).toBe("k2");
    expect(extractPresentedKey(headers({ Authorization: "bearer   k2 " }))).toBe("k2");
    expect(extractPresentedKey(headers({ Authorization: "k2" }))).toBe("k2");
  });
  it("returns null when nothing is presented", () => {
    expect(extractPresentedKey(headers({}))).toBeNull();
    expect(extractPresentedKey(headers({ Authorization: "   " }))).toBeNull();
  });
});

describe("authenticate", () => {
  const config = parseKeyConfig(CONFIG);
  it("maps each key to its own tenant", () => {
    const a = authenticate(headers({ Authorization: `Bearer ${KEY_A}` }), config);
    const b = authenticate(headers({ "x-api-key": KEY_B }), config);
    expect(a).toEqual({ ok: true, keyId: "allect-k1", tenantId: TENANT_A, label: "allect-grow" });
    expect(b).toEqual({ ok: true, keyId: "probe-k1", tenantId: TENANT_B, label: "internal-probe" });
  });
  it("rejects a wrong key, a missing key and an empty config", () => {
    expect(authenticate(headers({ Authorization: "Bearer nope" }), config)).toEqual({ ok: false, reason: "invalid" });
    expect(authenticate(headers({}), config)).toEqual({ ok: false, reason: "missing" });
    expect(authenticate(headers({ Authorization: `Bearer ${KEY_A}` }), [])).toEqual({ ok: false, reason: "no_config" });
  });
  it("rejects an expired entry", () => {
    const expired = parseKeyConfig(JSON.stringify([{ ...keyEntryFor(KEY_A, "k", TENANT_A, "l"), expires: "2026-01-01" }]));
    expect(authenticate(headers({ Authorization: `Bearer ${KEY_A}` }), expired, new Date("2026-09-16T00:00:00Z"))).toEqual({ ok: false, reason: "expired" });
    expect(authenticate(headers({ Authorization: `Bearer ${KEY_A}` }), expired, new Date("2025-12-31T00:00:00Z")).ok).toBe(true);
  });
  it("safeEqualHex handles different lengths and bad hex without throwing", () => {
    expect(safeEqualHex("ab", "abcd")).toBe(false);
    expect(safeEqualHex("zz", "zz")).toBe(true); // same bytes after lenient decode; still no throw
    expect(safeEqualHex(sha256Hex("x"), sha256Hex("x"))).toBe(true);
    expect(safeEqualHex(sha256Hex("x"), sha256Hex("y"))).toBe(false);
  });
  it("lists configured tenants once each", () => {
    const two = parseKeyConfig(JSON.stringify([keyEntryFor(KEY_A, "k1", TENANT_A, "l"), keyEntryFor(KEY_B, "k2", TENANT_A, "l2")]));
    expect(configuredTenants(two)).toEqual([TENANT_A]);
  });
});
