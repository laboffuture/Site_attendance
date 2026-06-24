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
  { label: "Attendance", href: "/attendance", icon: "schedule", cap: "mark_attendance", ready: true },
  { label: "Overtime", href: "/overtime", icon: "more_time", cap: "view_overtime", ready: true },
  { label: "Regularization", href: "/regularization", icon: "fact_check", cap: "view_regularization", ready: true },
  { label: "Requests", href: "/requests", icon: "assignment", cap: "view_requests", ready: true },
  { label: "Employees", href: "/workers", icon: "groups", cap: "enroll_worker", ready: true },
  { label: "Designations", href: "/designations", icon: "badge", cap: "add_designation", ready: true },
  { label: "Branches & Sites", href: "/org", icon: "apartment", cap: "view_org", ready: true },
  { label: "Stations", href: "/stations", icon: "desktop_windows", cap: "manage_stations", ready: true },
  { label: "Users & Roles", href: "/users", icon: "manage_accounts", cap: "manage_users", ready: true },
  { label: "Reports", href: "/reports", icon: "description", cap: "view_reports", ready: true },
  { label: "Payroll", href: "/payroll", icon: "payments", cap: "view_payroll", ready: true },
  { label: "Flagged", href: "/flags", icon: "flag", cap: "view_flags", ready: true },
];
