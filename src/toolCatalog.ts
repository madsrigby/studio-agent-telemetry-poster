// toolCatalog.ts — VENDORED from studio-agent (src/toolCatalog.ts). Do not edit
// by hand: the bot repo owns the contract (docs/operations/dashboard-contract-plan.md).
// Re-vendor when the bot catalog changes. HANDBOOK_BASELINE_MINUTES_JSON still
// overrides baselines at runtime with no redeploy.

export type FunctionCategory = "read" | "write" | "policy" | "resolver";

export interface ToolCatalogEntry {
  category: FunctionCategory;
  baseline_minutes: number;
  write: boolean;
  estimated?: boolean;
}

export const TOOL_CATALOG: Record<string, ToolCatalogEntry> = {
  // ── Employee self-service: reads ──────────────────────────────────────────
  get_my_employee_details: { category: "read", baseline_minutes: 3, write: false },
  list_my_absences: { category: "read", baseline_minutes: 3, write: false },
  list_my_bonuses: { category: "read", baseline_minutes: 4, write: false },
  list_my_sicknesses: { category: "read", baseline_minutes: 3, write: false },
  list_departments: { category: "read", baseline_minutes: 2, write: false },
  list_divisions: { category: "read", baseline_minutes: 2, write: false },
  list_locations: { category: "read", baseline_minutes: 2, write: false },
  list_working_patterns: { category: "read", baseline_minutes: 2, write: false },
  get_my_holiday_balance: { category: "read", baseline_minutes: 4, write: false, estimated: true },
  find_colleague: { category: "read", baseline_minutes: 3, write: false, estimated: true },

  // ── Employee self-service: write ──────────────────────────────────────────
  create_my_leave_request: { category: "write", baseline_minutes: 5, write: true },

  // ── Admin: reads ──────────────────────────────────────────────────────────
  list_employees: { category: "read", baseline_minutes: 3, write: false },
  admin_get_employee_details: { category: "read", baseline_minutes: 3, write: false },
  list_change_requests: { category: "read", baseline_minutes: 3, write: false },
  list_leave_requests: { category: "read", baseline_minutes: 3, write: false },
  get_leave_request: { category: "read", baseline_minutes: 3, write: false },
  admin_list_absences: { category: "read", baseline_minutes: 3, write: false },
  admin_list_bonuses: { category: "read", baseline_minutes: 3, write: false },
  admin_list_employee_bonuses: { category: "read", baseline_minutes: 3, write: false },
  get_company_account: { category: "read", baseline_minutes: 3, write: false },
  list_holiday_allowances: { category: "read", baseline_minutes: 3, write: false },
  admin_list_sicknesses: { category: "read", baseline_minutes: 3, write: false },
  admin_get_holiday_balance: { category: "read", baseline_minutes: 4, write: false, estimated: true },
  list_employees_by_group: { category: "read", baseline_minutes: 5, write: false, estimated: true },
  get_company_headcount: { category: "read", baseline_minutes: 3, write: false, estimated: true },

  // ── Admin: writes (record mutations) ──────────────────────────────────────
  create_employee: { category: "write", baseline_minutes: 15, write: true },
  create_change_request: { category: "write", baseline_minutes: 7, write: true },
  admin_create_leave_request: { category: "write", baseline_minutes: 5, write: true },
  cancel_absence: { category: "write", baseline_minutes: 5, write: true },

  // ── Admin: policy (approve/reject governance) ─────────────────────────────
  approve_change_request: { category: "policy", baseline_minutes: 5, write: true },
  approve_leave_request: { category: "policy", baseline_minutes: 3, write: true },
  reject_leave_request: { category: "policy", baseline_minutes: 5, write: true },
};

/** Functional category for ROI/dashboard. Unknown tools fall back to the
 * caller's heuristic (legacy pre-rename names are not in the catalog). */
export function catalogCategory(name: string): FunctionCategory | undefined {
  return TOOL_CATALOG[name]?.category;
}

/** Catalog baseline in minutes, or undefined for unknown/legacy names. */
export function catalogBaselineMinutes(name: string): number | undefined {
  return TOOL_CATALOG[name]?.baseline_minutes;
}
