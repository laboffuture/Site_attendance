import type { Role } from "../models/User";

/**
 * The permission matrix from spec §3, encoded as capability → allowed roles.
 * This is the single source of truth for route guards and nav visibility.
 *
 *   Action                    | Mgmt | HR  | PM  | PE  | Supervisor
 *   --------------------------|------|-----|-----|-----|-----------
 *   View dashboard/reports    | all-sites | all | own-sites | own | own
 *   Mark / override attendance| yes  | yes | yes | yes | yes
 *   Enroll new worker         | yes  | yes | yes | yes | yes
 *   Add new designation       | yes  | yes | yes | yes | yes
 *   View overtime queue       | yes  | yes | view| no  | no
 *   Approve overtime          | yes  | yes | no  | no  | no
 *   View branches / sites     | yes  | view| view| no  | no
 *   Manage branches / sites   | yes  | no  | no  | no  | no
 *   Manage user accounts      | yes  | yes | no  | no  | no
 *
 * (Site scoping — "all sites" vs "own site" — is enforced separately via the
 *  user's assignedSiteIds, not here.)
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
  | "manage_users";

const ALL: Role[] = ["management", "hr", "pm", "pe", "supervisor"];

export const CAPABILITY_ROLES: Record<Capability, Role[]> = {
  view_dashboard: ALL,
  mark_attendance: ALL,
  enroll_worker: ALL,
  add_designation: ALL,
  view_overtime: ["management", "hr", "pm"],
  approve_overtime: ["management", "hr"],
  view_org: ["management", "hr", "pm"],
  manage_org: ["management"],
  manage_users: ["management", "hr"],
};

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITY_ROLES[capability].includes(role);
}
