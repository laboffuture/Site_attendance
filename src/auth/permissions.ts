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
 *   Approve overtime          | yes | yes  | yes | no  | no
 *   View branches / sites     | yes | yes  | view| view| no
 *   Manage branches / sites   | yes | yes  | no  | no  | no
 *   Manage user accounts      | yes | yes  | yes | no  | no
 *
 * (Site scoping — "all sites" vs "own site" — is enforced via assignedSiteIds.)
 */
export type Capability =
  | "view_dashboard"
  | "mark_attendance"
  | "enroll_worker"
  | "add_designation"
  | "view_overtime"
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
  approve_overtime: ["management", "hr"], // HR + Management approve/adjust/reject OT
  view_org: ["management", "hr", "pm", "supervisor"], // supervisor = read-only, own sites
  manage_org: ["management"], // branches + stations
  manage_sites: ["management", "hr"], // HR+ can add/edit project sites
  manage_users: ["management", "hr"],
  delete_worker: ["management", "hr"],
  // Requests subsystem (scheduled OT + offload). Flow: create → PM recommends
  // → admin decides (admins may also decide directly from pending).
  view_requests: ["management", "hr", "pm", "supervisor"],
  create_request: ["management", "hr", "pm", "supervisor"],
  recommend_request: ["pm"],
  decide_request: ["management", "hr"], // the admin approval group
  // Daily attendance regularization chain (submit → recommend → approve).
  submit_attendance: ["hr", "pm", "supervisor"], // Management verifies/approves, doesn't submit
  view_regularization: ["management", "hr", "pm"],
  recommend_attendance: ["management", "pm"],
  approve_attendance: ["management", "hr"],
};

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITY_ROLES[capability].includes(role);
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
