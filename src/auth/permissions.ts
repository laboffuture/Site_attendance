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
  | "manage_users"
  | "delete_worker"
  | "view_requests"
  | "create_request"
  | "recommend_request"
  | "decide_request";

const ALL: Role[] = [...ROLES];

export const CAPABILITY_ROLES: Record<Capability, Role[]> = {
  view_dashboard: ALL,
  mark_attendance: ALL,
  enroll_worker: ALL,
  add_designation: ALL,
  view_overtime: ["super_admin", "management", "hr", "pm"],
  approve_overtime: ["super_admin", "management", "hr"],
  view_org: ["super_admin", "management", "hr", "pm", "supervisor"], // supervisor = read-only, own sites
  manage_org: ["super_admin", "management"],
  manage_users: ["super_admin", "management", "hr"],
  delete_worker: ["super_admin", "management", "hr"],
  // Requests subsystem (scheduled OT + offload). Flow: create → PM recommends
  // → admin decides. Recommend is mandatory before an admin can approve.
  view_requests: ["super_admin", "management", "hr", "pm", "supervisor"],
  create_request: ["super_admin", "management", "hr", "pm", "supervisor"],
  recommend_request: ["pm", "super_admin"], // super_admin can recommend to avoid deadlock
  decide_request: ["super_admin", "management", "hr"], // the admin approval group
};

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITY_ROLES[capability].includes(role);
}

/** Roles that see every site and store no assignedSiteIds (top admins). */
export function seesAllSites(role: Role): boolean {
  return role === "super_admin" || role === "management" || role === "hr";
}

/** Human-friendly role labels for display. */
export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  management: "Management",
  hr: "HR",
  pm: "PM",
  supervisor: "Supervisor",
};

export function roleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role;
}
