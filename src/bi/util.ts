// Small shared helpers for the BI API and the aggregation module.

export function safeJsonParse(value: string | undefined | null, fallback: any = {}): any {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Inverted-timestamp row key prefix used by telemetryevents (newest first). */
export function invertedTs(epochMs: number): string {
  return String(9999999999999 - epochMs).padStart(13, "0");
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isoMonth(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function addMonths(monthStr: string, months: number): string {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return isoMonth(d);
}

export function daysInMonth(monthStr: string): number {
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Inclusive list of YYYY-MM-DD between from and to. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Inclusive list of YYYY-MM between from and to. */
export function eachMonth(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function daysBetweenInclusive(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00.000Z`).getTime();
  const b = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86400000) + 1;
}
