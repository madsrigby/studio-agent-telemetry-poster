// baselines.ts — the ONE place that turns a tool name into minutes saved and a
// functional category. Moved verbatim from Analyticsfunction.ts so the dashboard
// API, the daily aggregation and the BI API all compute the same numbers.
//
// Precedence for baseline minutes (unchanged):
//   HANDBOOK_BASELINE_MINUTES_JSON (env) > vendored bot catalog > legacy map > 3.

import { createHash } from "crypto";
import { TOOL_CATALOG, catalogCategory, catalogBaselineMinutes } from "./toolCatalog";

export const DEFAULT_BASELINE_MINUTES: Record<string, number> = {
  get_my_employee_details: 3, create_my_leave_request: 5, list_my_absences: 3,
  list_my_bonuses: 4, list_departments: 2, list_divisions: 2, list_locations: 2,
  list_working_patterns: 2, list_employees: 3, get_employee_details: 3,
  create_employee: 15, create_employee_change_request: 7, list_change_requests: 3,
  approve_change_request: 5, list_leave_requests: 3, get_leave_request: 3,
  create_leave_request: 5, approve_leave_request: 3, reject_leave_request: 5,
  list_absences: 3, cancel_absence: 5, list_all_bonuses: 3,
  list_employee_bonuses: 3, get_company_account_details: 3, list_holiday_allowances: 3,
  resolve_employee_id: 1, list_my_sicknesses: 3, list_sicknesses: 3,
  update_sickness: 5, approve_leave_request_admin: 3, reject_leave_request_admin: 5,
  create_leave_request_admin: 5, get_leave_request_admin: 3, list_leave_requests_admin: 3,
};

export const DEFAULT_FLOOR_MINUTES = 3;

export function getHandbookBaselines(raw: string | undefined = process.env.HANDBOOK_BASELINE_MINUTES_JSON): Record<string, number> {
  try {
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) clean[k] = n;
    }
    return clean;
  } catch {
    return {};
  }
}

export const HANDBOOK_BASELINES = getHandbookBaselines();

export type BaselineSource = "env" | "catalog" | "legacy" | "default";

export interface BaselineInfo {
  minutes: number;
  source: BaselineSource;
  /** true when the catalog marks the baseline as an unconfirmed estimate */
  estimated: boolean;
}

export interface BaselineEnv {
  handbook?: Record<string, number>;
}

/** Full provenance for a tool's baseline. */
export function baselineForTool(toolName: string, env: BaselineEnv = {}): BaselineInfo {
  const handbook = env.handbook ?? HANDBOOK_BASELINES;
  const estimated = TOOL_CATALOG[toolName]?.estimated === true;
  if (handbook[toolName]) return { minutes: handbook[toolName], source: "env", estimated };
  const cat = catalogBaselineMinutes(toolName);
  if (cat) return { minutes: cat, source: "catalog", estimated };
  if (DEFAULT_BASELINE_MINUTES[toolName]) return { minutes: DEFAULT_BASELINE_MINUTES[toolName], source: "legacy", estimated };
  return { minutes: DEFAULT_FLOOR_MINUTES, source: "default", estimated };
}

/** Same precedence as always; kept for the dashboard call sites. */
export function baselineMinutesForTool(toolName: string, env: BaselineEnv = {}): number {
  return baselineForTool(toolName, env).minutes;
}

export type CategorySource = "catalog" | "heuristic";

export function categoryWithSource(toolName: string): { category: string; source: CategorySource } {
  const cat = catalogCategory(toolName);
  if (cat) return { category: cat, source: "catalog" };
  const heuristic =
    toolName.startsWith("create") || toolName.startsWith("update") || toolName.startsWith("cancel") ? "write"
      : toolName.startsWith("approve") || toolName.startsWith("reject") ? "policy"
        : toolName.startsWith("resolve") ? "resolver"
          : "read";
  return { category: heuristic, source: "heuristic" };
}

export function categoryForTool(toolName: string): string {
  return categoryWithSource(toolName).category;
}

export const DEFAULT_HOURLY_RATE = 45;

export function hourlyRate(raw: string | undefined = process.env.DEFAULT_HOURLY_RATE): number {
  const n = parseFloat(raw || "");
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HOURLY_RATE;
}

/**
 * Identifies the exact baseline assumptions a number was computed under:
 * vendored catalog ⊕ env override ⊕ legacy map ⊕ hourly rate. Stored on every
 * aggregated row so a baseline change is visible instead of silent.
 */
export function baselinesVersion(env: BaselineEnv & { rate?: number } = {}): string {
  const material = JSON.stringify({
    catalog: TOOL_CATALOG,
    handbook: env.handbook ?? HANDBOOK_BASELINES,
    legacy: DEFAULT_BASELINE_MINUTES,
    rate: env.rate ?? hourlyRate(),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

/** Every tool name the system knows a baseline for (catalog ∪ env ∪ legacy). */
export function knownToolNames(env: BaselineEnv = {}): string[] {
  const handbook = env.handbook ?? HANDBOOK_BASELINES;
  return Array.from(new Set([...Object.keys(TOOL_CATALOG), ...Object.keys(handbook), ...Object.keys(DEFAULT_BASELINE_MINUTES)])).sort();
}
