import { Capability } from "./auth/permissions";

export interface NavItem {
  label: string;
  href: string;
  icon: string; // Material Icons name
  cap: Capability;
  ready: boolean; // false → shown greyed with a "soon" tag (no dead links)
}

/** Sidebar navigation. Each role sees only items its capabilities allow.
 *  `ready` flips to true as each module lands. */
export const NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: "dashboard", cap: "view_dashboard", ready: true },
  { label: "Attendance", href: "/attendance", icon: "schedule", cap: "mark_attendance", ready: false },
  { label: "Overtime", href: "/overtime", icon: "more_time", cap: "view_overtime", ready: false },
  { label: "Workers", href: "/workers", icon: "groups", cap: "enroll_worker", ready: false },
  { label: "Designations", href: "/designations", icon: "badge", cap: "add_designation", ready: false },
  { label: "Branches & Sites", href: "/org", icon: "apartment", cap: "view_org", ready: false },
  { label: "Users & Roles", href: "/users", icon: "manage_accounts", cap: "manage_users", ready: false },
  { label: "Reports", href: "/reports", icon: "description", cap: "view_dashboard", ready: false },
];
