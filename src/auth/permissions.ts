import { Role, ROLES } from "../models/User";

/**
 * The permission matrix, encoded as capability → allowed roles.
 * Single source of truth for route guards and nav visibility.
 *
 * Roles: Management (owner) → HR → PM → Supervisor. Management + HR see all
 * sites; PM + Supervisor are scoped to assignedSiteIds.
 *
 *   Capability                | Mgmt | HR  | PM  | Supervisor
 *   --------------------------|------|-----|-----|-----------
 *   Dashboard / Reports       | yes  | yes | yes | yes
 *   Attendance (log + submit) | log  | yes | yes | yes
 *   Requests (raise)          | yes  | yes | yes | yes
 *   Employees (enrol)         | yes  | yes | yes | yes
 *   Recommend OT/Reg/Requests | —    | yes | yes | no
 *   Approve / close (all)     | yes  | no  | no  | no
 *   Stations (key + share)    | yes  | yes | yes | yes
 *   Users & Roles             | yes  | yes | no  | no
 *   Designations              | yes  | yes | no  | no
 *   Branches & Sites          | yes  | yes | no  | no
 *   Payroll                   | yes  | yes | no  | no
 *   Flagged                   | yes  | yes | no  | no
 *
 * Approval authority: HR + PM RECOMMEND across Overtime / Regularization /
 * Requests; Management is the last to CLOSE (approve/decide). Supervisor logs &
 * submits but does not recommend. (Scoping enforced via assignedSiteIds.)
 */
export type Capability =
  | "view_dashboard"
  | "view_reports"
  | "view_payroll"
  | "view_flags"
  | "mark_attendance"
  | "enroll_worker"
  | "add_designation"
  | "view_overtime"
  | "recommend_overtime"
  | "approve_overtime"
  | "view_org"
  | "manage_org"
  | "manage_sites"
  | "manage_stations"
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
  view_dashboard: ALL, // home dashboard (scoped per role)
  view_reports: ALL, // view + download reports (all roles)
  view_payroll: ["management", "hr"], // payroll run + money — admins only
  view_flags: ["management", "hr"], // spoof/geofence flags queue — admins only
  mark_attendance: ["hr", "pm", "supervisor"], // who LOGS attendance; Management verifies, not logs
  enroll_worker: ALL, // register/enrol workers (incl. field face-enrolment)
  add_designation: ["management", "hr"],
  view_overtime: ["management", "hr", "pm"], // PM sees the queue to recommend; supervisor no
  recommend_overtime: ["hr", "pm"], // HR + PM raise/recommend OT…
  approve_overtime: ["management"], // …Management is the last to close (approve/adjust/reject)
  view_org: ["management", "hr"], // branches & sites — admins only
  manage_org: ["management", "hr"], // branches
  manage_sites: ["management", "hr"], // project sites
  manage_stations: ["management", "hr", "pm", "supervisor"], // kiosk: PM + Supervisor get the key + share the link/QR
  manage_users: ["management", "hr"], // user accounts & roles — admins only
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
