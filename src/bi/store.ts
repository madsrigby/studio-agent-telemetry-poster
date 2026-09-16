// store.ts — the ONLY place the BI API touches TableClient. Everything above
// this file works against these two small interfaces, which the tests fake.

import { TableClient } from "@azure/data-tables";
import { odataString } from "./query";
import { invertedTs, safeJsonParse } from "./util";
import type { RawEventRow } from "../aggregation/aggregateDay";
import type { RetentionStore } from "../retention/retention";

export interface MetricsStore {
  /** telemetrymetrics rows for one tenant with rowKey in [fromKey, toKey]. */
  listRange(tenantId: string, fromKey: string, toKey: string): Promise<any[]>;
  /** Newest rowKey (YYYY-MM-DD) for the tenant at or after sinceKey, or null. */
  latestDate(tenantId: string, sinceKey: string): Promise<string | null>;
  /** Distinct partition keys present in the table. */
  tenants(): Promise<string[]>;
  /** Replace-upsert one entity. */
  upsert(entity: Record<string, any>): Promise<void>;
}

export interface EventsStore {
  /** Newest event of any type in the tenant partition. */
  newestEvent(tenantId: string): Promise<{ timestamp: string; eventType: string } | null>;
  /** Newest turn_completed in the tenant partition (bounded scan). */
  newestTurn(tenantId: string): Promise<{ timestamp: string } | null>;
  /** Distinct user_hash values among turn_completed events in [from, to] (UTC days). */
  userHashesInRange(tenantId: string, from: string, to: string, deadlineMs: number): Promise<{ hashes: Set<string>; complete: boolean }>;
  /** Raw events across partitions with RowKey in [rowKeyGe, rowKeyLe] (aggregation). */
  scanEvents(rowKeyGe: string, rowKeyLe: string): AsyncIterable<RawEventRow>;
}

export function tableMetricsStore(client: TableClient): MetricsStore {
  return {
    async listRange(tenantId, fromKey, toKey) {
      const out: any[] = [];
      const it = client.listEntities({
        queryOptions: {
          filter: `PartitionKey eq '${odataString(tenantId)}' and RowKey ge '${odataString(fromKey)}' and RowKey le '${odataString(toKey)}'`,
        },
      });
      for await (const e of it) out.push(e);
      return out;
    },
    async latestDate(tenantId, sinceKey) {
      let latest: string | null = null;
      const it = client.listEntities({
        queryOptions: {
          filter: `PartitionKey eq '${odataString(tenantId)}' and RowKey ge '${odataString(sinceKey)}'`,
          select: ["PartitionKey", "RowKey"],
        },
      });
      for await (const e of it) {
        const k = String(e.rowKey);
        if (latest === null || k > latest) latest = k;
      }
      return latest;
    },
    async tenants() {
      const seen = new Set<string>();
      const it = client.listEntities({ queryOptions: { select: ["PartitionKey"] } });
      for await (const e of it) seen.add(String(e.partitionKey));
      return Array.from(seen);
    },
    async upsert(entity) {
      await client.upsertEntity(entity as any, "Replace");
    },
  };
}

/** Retention needs three primitives; kept separate so the BI stores stay read-only. */
export function tableRetentionStore(client: TableClient): RetentionStore {
  return {
    listOlderThan(rowKeyGt) {
      const it = client.listEntities({
        queryOptions: { filter: `RowKey gt '${odataString(rowKeyGt)}'`, select: ["PartitionKey", "RowKey"] },
      });
      return (async function* () {
        for await (const e of it) yield { partitionKey: String(e.partitionKey), rowKey: String(e.rowKey) };
      })();
    },
    async countRows() {
      let n = 0;
      const it = client.listEntities({ queryOptions: { select: ["PartitionKey"] } });
      for await (const _ of it) n++;
      return n;
    },
    async deleteRow(ref) {
      await client.deleteEntity(ref.partitionKey, ref.rowKey);
    },
  };
}

const NEWEST_TURN_MAX_PAGES = 50;

export function tableEventsStore(client: TableClient): EventsStore {
  return {
    async newestEvent(tenantId) {
      // Inverted RowKey: the first row of the partition is the newest event.
      const pages = client
        .listEntities({
          queryOptions: { filter: `PartitionKey eq '${odataString(tenantId)}'`, select: ["RowKey", "eventType", "timestamp"] },
        })
        .byPage({ maxPageSize: 1 });
      for await (const page of pages) {
        for (const e of page) {
          return { timestamp: String(e.timestamp ?? ""), eventType: String(e.eventType ?? "") };
        }
        // An empty page with a continuation token can occur; keep going once.
        break;
      }
      return null;
    },
    async newestTurn(tenantId) {
      const pages = client
        .listEntities({
          queryOptions: {
            filter: `PartitionKey eq '${odataString(tenantId)}' and eventType eq 'turn_completed'`,
            select: ["RowKey", "timestamp"],
          },
        })
        .byPage({ maxPageSize: 1 });
      let n = 0;
      for await (const page of pages) {
        for (const e of page) return { timestamp: String(e.timestamp ?? "") };
        if (++n >= NEWEST_TURN_MAX_PAGES) break;
      }
      return null;
    },
    async userHashesInRange(tenantId, from, to, deadlineMs) {
      const start = Date.now();
      const rowKeyGe = invertedTs(new Date(`${to}T23:59:59.999Z`).getTime());
      const rowKeyLe = invertedTs(new Date(`${from}T00:00:00.000Z`).getTime());
      const hashes = new Set<string>();
      const pages = client
        .listEntities({
          queryOptions: {
            filter: `PartitionKey eq '${odataString(tenantId)}' and RowKey ge '${rowKeyGe}' and RowKey le '${rowKeyLe}' and eventType eq 'turn_completed'`,
            select: ["RowKey", "userHash", "payload"],
          },
        })
        .byPage({ maxPageSize: 1000 });
      for await (const page of pages) {
        for (const e of page) {
          const h = (e.userHash as string) || safeJsonParse(e.payload as string).user_hash;
          if (h) hashes.add(String(h));
        }
        if (Date.now() - start > deadlineMs) return { hashes, complete: false };
      }
      return { hashes, complete: true };
    },
    scanEvents(rowKeyGe, rowKeyLe) {
      const it = client.listEntities({
        queryOptions: {
          filter: `RowKey ge '${odataString(rowKeyGe)}' and RowKey le '${odataString(rowKeyLe)}'`,
          select: ["PartitionKey", "RowKey", "eventType", "payload"],
        },
      });
      return (async function* () {
        for await (const e of it) {
          yield { partitionKey: String(e.partitionKey), eventType: String(e.eventType ?? ""), payload: String(e.payload ?? "") };
        }
      })();
    },
  };
}
