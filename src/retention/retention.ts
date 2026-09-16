// retention.ts — deletes raw telemetryevents older than RETENTION_MONTHS
// (default 13, matching the client data statement). Never touches the
// aggregates in telemetrymetrics.
//
// Safety: dry-run is the DEFAULT (RETENTION_DRY_RUN unset or "true" → count
// only). A real run aborts when it would delete more than RETENTION_MAX_FRACTION
// (default 0.10) of all rows, so a clock or config mistake cannot empty the table.

import { invertedTs } from "../bi/util";

export interface RetentionConfig {
  months: number;
  dryRun: boolean;
  maxFraction: number;
}

export function readRetentionConfig(env: Record<string, string | undefined> = process.env): RetentionConfig {
  const months = parseInt(env.RETENTION_MONTHS || "", 10);
  const frac = parseFloat(env.RETENTION_MAX_FRACTION || "");
  const dry = (env.RETENTION_DRY_RUN ?? "true").toLowerCase() !== "false";
  return {
    months: Number.isFinite(months) && months >= 1 ? months : 13,
    dryRun: dry,
    maxFraction: Number.isFinite(frac) && frac > 0 && frac <= 1 ? frac : 0.1,
  };
}

export function cutoffDate(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** Rows OLDER than the cutoff have a LARGER inverted RowKey prefix. */
export function olderThanRowKey(cutoff: Date): string {
  return invertedTs(cutoff.getTime());
}

export interface RowRef {
  partitionKey: string;
  rowKey: string;
}

export interface RetentionStore {
  /** Row keys with RowKey greater than rowKeyGt (i.e. older than the cutoff). */
  listOlderThan(rowKeyGt: string): AsyncIterable<RowRef>;
  /** Total row count (used for the safety fraction). */
  countRows(): Promise<number>;
  deleteRow(ref: RowRef): Promise<void>;
}

export interface SweepResult {
  cutoff: string;
  total: number;
  candidates: number;
  deleted: number;
  dryRun: boolean;
  aborted: boolean;
  reason?: string;
}

export async function sweep(
  store: RetentionStore,
  cfg: RetentionConfig,
  log: (m: string) => void,
  now: Date = new Date()
): Promise<SweepResult> {
  const cutoff = cutoffDate(now, cfg.months);
  const key = olderThanRowKey(cutoff);
  const total = await store.countRows();
  const refs: RowRef[] = [];
  for await (const r of store.listOlderThan(key)) refs.push(r);
  const base: SweepResult = { cutoff: cutoff.toISOString(), total, candidates: refs.length, deleted: 0, dryRun: cfg.dryRun, aborted: false };

  if (refs.length === 0) {
    log(`[Retention] nothing older than ${base.cutoff} (total ${total} rows)`);
    return base;
  }
  if (cfg.dryRun) {
    log(`[Retention] DRY RUN: ${refs.length} of ${total} rows are older than ${base.cutoff}; nothing deleted`);
    return base;
  }
  if (total > 0 && refs.length / total > cfg.maxFraction) {
    const reason = `would delete ${refs.length}/${total} (${Math.round((refs.length / total) * 100)}%) > max ${Math.round(cfg.maxFraction * 100)}%`;
    log(`[Retention] Error: aborted — ${reason}`);
    return { ...base, aborted: true, reason };
  }
  let deleted = 0;
  for (const r of refs) {
    await store.deleteRow(r);
    deleted++;
  }
  log(`[Retention] deleted ${deleted} rows older than ${base.cutoff} (total before ${total})`);
  return { ...base, deleted };
}
