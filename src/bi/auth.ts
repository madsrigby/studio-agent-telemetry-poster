// auth.ts — API-key auth for the BI API.
//
// BI_API_KEYS holds HASHES, never keys:
//   [{"id":"allect-k1","sha256":"<hex>","tenant_id":"<uuid>","label":"allect-grow"}]
// A leaked app-settings dump is therefore harmless. The presented key is
// hashed and compared in constant time against every entry. The matched entry
// decides the tenant — callers can never choose one.
//
// Fail closed: no config, bad JSON, empty array, malformed entry → nobody
// authenticates. This is the opposite of the webhook's `if (expectedKey)`.

import { createHash, timingSafeEqual } from "crypto";

export interface KeyEntry {
  id: string;
  sha256: string; // lowercase hex, 64 chars
  tenantId: string;
  label: string;
  expires?: string; // ISO date; optional
}

export type AuthResult =
  | { ok: true; keyId: string; tenantId: string; label: string }
  | { ok: false; reason: "no_config" | "missing" | "invalid" | "expired" };

const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Parses BI_API_KEYS. Returns [] on ANY problem (fail closed). */
export function parseKeyConfig(raw: string | undefined | null): KeyEntry[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  const out: KeyEntry[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") return [];
    const { id, sha256, tenant_id, label, expires } = e as Record<string, unknown>;
    if (typeof id !== "string" || !id) return [];
    if (typeof sha256 !== "string" || !HEX64.test(sha256.toLowerCase())) return [];
    if (typeof tenant_id !== "string" || !tenant_id) return [];
    out.push({
      id,
      sha256: sha256.toLowerCase(),
      tenantId: tenant_id,
      label: typeof label === "string" && label ? label : id,
      expires: typeof expires === "string" && expires ? expires : undefined,
    });
  }
  return out;
}

export interface HeaderReader {
  get(name: string): string | null;
}

/** x-api-key first; else Authorization with an optional "Bearer " prefix. Never the query string. */
export function extractPresentedKey(headers: HeaderReader): string | null {
  const direct = headers.get("x-api-key");
  if (direct && direct.trim()) return direct.trim();
  const auth = headers.get("authorization");
  if (!auth || !auth.trim()) return null;
  const v = auth.trim();
  const m = /^bearer\s+(.+)$/i.exec(v);
  return (m ? m[1] : v).trim() || null;
}

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function authenticate(headers: HeaderReader, config: KeyEntry[], now: Date = new Date()): AuthResult {
  if (config.length === 0) return { ok: false, reason: "no_config" };
  const presented = extractPresentedKey(headers);
  if (!presented) return { ok: false, reason: "missing" };
  const digest = sha256Hex(presented);
  let matched: KeyEntry | null = null;
  // Always walk every entry so timing does not depend on the match position.
  for (const entry of config) {
    if (safeEqualHex(digest, entry.sha256) && !matched) matched = entry;
  }
  if (!matched) return { ok: false, reason: "invalid" };
  if (matched.expires && new Date(matched.expires).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, keyId: matched.id, tenantId: matched.tenantId, label: matched.label };
}

export function configuredTenants(config: KeyEntry[]): string[] {
  return Array.from(new Set(config.map((e) => e.tenantId)));
}

/** Helper for operators: the entry to paste for a freshly generated key. */
export function keyEntryFor(key: string, id: string, tenantId: string, label: string): Record<string, string> {
  return { id, sha256: sha256Hex(key), tenant_id: tenantId, label };
}
