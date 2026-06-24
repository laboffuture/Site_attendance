import { Role, ROLES } from "../models/User";

/**
 * The permission matrix, encoded as capability → allowed roles.
 * Single source of truth for route guards and nav visibility.
 *
 * Hierarchy (top→bottom): Super Admin → Management → HR → PM → Supervisor.
 * Super Admin is the chairman/override (everything Management can do, and the
 * only role that can manage other Super Admins / Management). PE is removed.
 *
 *   Action                    | SuperAdmin | Mgmt | HR  | PM  | Supervisor
 *   --------------------------|------------|------|-----|-----|-----------
 *   View dashboard/reports    | all | all-sites | all | own-sites | own | own
 *   Mark / override attendance| yes | yes  | yes | yes | yes
 *   Enroll / register employee| yes | yes  | yes | yes | yes
 *   Add new designation       | yes | yes  | yes | yes | yes
 *   View overtime queue       | yes | yes  | yes | view| no
 *   Recommend (raise) OT      | yes | no   | yes | no  | no
 *   Approve / close OT        | yes | yes  | no  | no  | no
 *   View branches / sites     | yes | yes  | view| view| no
 *   Manage branches / sites   | yes | yes  | yes | no  | no
 *   Manage user accounts      | yes | yes  | yes | no  | no
 *
 * Approval authority (HR recommends → Management closes): across Overtime,
 * Regularization and Requests, HR (and PM) RECOMMEND, and Management is the
 * last to CLOSE (approve/decide). HR keeps full people-ops + payroll otherwise.
 * (Site scoping — "all sites" vs "own site" — is enforced via assignedSiteIds.)
 */
export type Capability =
  | "view_dashboard"
  | "mark_attendance"
  | "enroll_worker"
  | "add_designation"
  | "view_overtime"
  | "recommend_overtime"
  | "approve_overtime"
  | "view_org"
  | "manage_org"
  | "manage_sites"
  | "manage_users"
  | "delete_worker"
  | "view_requests"
  | "create_request"
  | "recommend_request"
  | "decide_request"
  | "submit_attendance"
  | "view_regularization"
  | "recommend_attendance"
  | "approve_attendance";

const ALL: Role[] = [...ROLES];

const CAPABILITY_ROLES: Record<Capability, Role[]> = {
  view_dashboard: ALL,
  mark_attendance: ["hr", "pm", "supervisor"], // who LOGS attendance; Management verifies, not logs
  enroll_worker: ALL,
  add_designation: ALL,
  view_overtime: ["management", "hr", "pm"], // PM = view-only
  recommend_overtime: ["hr"], // HR raises/recommends OT…
  approve_overtime: ["management"], // …and Management is the last to close (approve/adjust/reject)
  view_org: ["management", "hr", "pm", "supervisor"], // supervisor = read-only, own sites
  manage_org: ["management", "hr"], // branches + stations (HR has full org access too)
  manage_sites: ["management", "hr"], // HR+ can add/edit project sites
  manage_users: ["management", "hr"],
  delete_worker: ["management", "hr"],
  // Requests subsystem (scheduled OT + offload). Flow: create → PM recommends
  // → admin decides (admins may also decide directly from pending).
  view_requests: ["management", "hr", "pm", "supervisor"],
  create_request: ["management", "hr", "pm", "supervisor"],
  recommend_request: ["hr", "pm"], // HR + PM recommend (raise)…
  decide_request: ["management"], // …Management closes (decide)
  // Daily attendance regularization chain (submit → recommend → approve).
  submit_attendance: ["hr", "pm", "supervisor"], // Management verifies/approves, doesn't submit
  view_regularization: ["management", "hr", "pm"],
  recommend_attendance: ["hr", "pm"], // HR + PM recommend…
  approve_attendance: ["management"], // …Management is the last to close
};

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITY_ROLES[capability].includes(role);
}

/** Every capability key, in matrix order — used to render permission editors. */
export const ALL_CAPABILITIES = Object.keys(CAPABILITY_ROLES) as Capability[];

/** Effective permission for a specific user: an explicit per-user capability
 *  list (when set) overrides the role; otherwise the role's defaults apply. */
export function userCan(
  user: { role: Role; capabilities?: string[] | null },
  capability: Capability,
): boolean {
  if (user.capabilities && user.capabilities.length) return user.capabilities.includes(capability);
  return can(user.role, capability);
}

/** Roles that see every site and store no assignedSiteIds (top admins). */
export function seesAllSites(role: Role): boolean {
  return role === "management" || role === "hr";
}

/** Human-friendly role labels for display. */
const ROLE_LABELS: Record<Role, string> = {
  management: "Management",
  hr: "HR",
  pm: "PM",
  supervisor: "Supervisor",
};

export function roleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role;
}
