import { describe, expect, it } from "vitest";
import { CANARY_TENANT, buildCanaryEnvelope, encodeQueueMessage, sendCanary } from "../src/canary/canary";
import { cutoffDate, olderThanRowKey, readRetentionConfig, sweep, type RetentionStore, type RowRef } from "../src/retention/retention";
import { invertedTs } from "../src/bi/util";

describe("canary", () => {
  it("builds a turn_completed envelope for the probe tenant, encoded like the bot", () => {
    const now = new Date("2026-09-17T01:00:00.000Z");
    const env = buildCanaryEnvelope(now);
    expect(env).toMatchObject({ event_type: "turn_completed", tenant_id: CANARY_TENANT, outcome: "success", relevance_result_code: "canary", timestamp: now.toISOString() });
    const decoded = JSON.parse(Buffer.from(encodeQueueMessage(env), "base64").toString("utf8"));
    expect(decoded).toEqual(env);
  });
  it("sends exactly one message", async () => {
    const sent: string[] = [];
    const env = await sendCanary({ async sendMessage(b: string) { sent.push(b); } }, new Date("2026-09-17T01:00:00.000Z"));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(Buffer.from(sent[0], "base64").toString("utf8")).correlation_id).toBe(env.correlation_id);
  });
});

function fakeStore(rows: Array<{ pk: string; ageMonths: number }>, now: Date): RetentionStore & { deleted: RowRef[] } {
  const refs = rows.map((r, i) => {
    const d = new Date(now.getTime());
    d.setUTCMonth(d.getUTCMonth() - r.ageMonths);
    return { partitionKey: r.pk, rowKey: `${invertedTs(d.getTime())}_turn_completed_${i}` };
  });
  const deleted: RowRef[] = [];
  return {
    deleted,
    async *listOlderThan(rowKeyGt) {
      for (const r of refs) if (r.rowKey > rowKeyGt) yield r;
    },
    async countRows() {
      return refs.length;
    },
    async deleteRow(ref) {
      deleted.push(ref);
    },
  };
}

describe("retention", () => {
  const now = new Date("2026-09-16T03:00:00.000Z");
  it("config defaults: 13 months, dry-run ON, 10% guard; false disables dry-run", () => {
    expect(readRetentionConfig({})).toEqual({ months: 13, dryRun: true, maxFraction: 0.1 });
    expect(readRetentionConfig({ RETENTION_DRY_RUN: "false", RETENTION_MONTHS: "6", RETENTION_MAX_FRACTION: "0.5" })).toEqual({ months: 6, dryRun: false, maxFraction: 0.5 });
    expect(readRetentionConfig({ RETENTION_DRY_RUN: "no", RETENTION_MONTHS: "0" }).dryRun).toBe(true);
  });
  it("cutoff key: older rows have larger inverted keys", () => {
    const c = cutoffDate(now, 13);
    expect(c.toISOString()).toBe("2025-08-16T03:00:00.000Z");
    const older = invertedTs(new Date("2025-01-01T00:00:00Z").getTime());
    const newer = invertedTs(new Date("2026-01-01T00:00:00Z").getTime());
    expect(older > olderThanRowKey(c)).toBe(true);
    expect(newer > olderThanRowKey(c)).toBe(false);
  });
  it("dry run counts and deletes nothing", async () => {
    const s = fakeStore([{ pk: "t", ageMonths: 20 }, { pk: "t", ageMonths: 1 }], now);
    const logs: string[] = [];
    const r = await sweep(s, { months: 13, dryRun: true, maxFraction: 0.1 }, (m) => logs.push(m), now);
    expect(r).toMatchObject({ total: 2, candidates: 1, deleted: 0, dryRun: true, aborted: false });
    expect(s.deleted).toHaveLength(0);
    expect(logs[0]).toMatch(/DRY RUN/);
  });
  it("real run aborts above the safety fraction and logs an Error line", async () => {
    const s = fakeStore([{ pk: "t", ageMonths: 20 }, { pk: "t", ageMonths: 20 }, { pk: "t", ageMonths: 1 }], now);
    const logs: string[] = [];
    const r = await sweep(s, { months: 13, dryRun: false, maxFraction: 0.1 }, (m) => logs.push(m), now);
    expect(r.aborted).toBe(true);
    expect(s.deleted).toHaveLength(0);
    expect(logs[0]).toMatch(/\[Retention\] Error/);
  });
  it("real run deletes only the old rows when under the fraction", async () => {
    const rows = [{ pk: "t", ageMonths: 20 }, ...Array.from({ length: 20 }, () => ({ pk: "t", ageMonths: 1 }))];
    const s = fakeStore(rows, now);
    const r = await sweep(s, { months: 13, dryRun: false, maxFraction: 0.1 }, () => {}, now);
    expect(r).toMatchObject({ total: 21, candidates: 1, deleted: 1, aborted: false });
    expect(s.deleted[0].rowKey).toMatch(/_turn_completed_0$/);
  });
  it("nothing to do is not an error", async () => {
    const s = fakeStore([{ pk: "t", ageMonths: 1 }], now);
    const r = await sweep(s, { months: 13, dryRun: false, maxFraction: 0.1 }, () => {}, now);
    expect(r).toMatchObject({ candidates: 0, deleted: 0, aborted: false });
  });
});
