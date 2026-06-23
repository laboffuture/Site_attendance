import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { seesAllSites, roleLabel, can, userCan, ALL_CAPABILITIES, Capability } from "../auth/permissions";
import type { CurrentUser } from "../auth/types";
import { hashPassword } from "../auth/password";
import { isDuplicateKeyError, escapeRegex } from "../lib/validate";
import { ProjectSiteModel } from "../models/ProjectSite";
import { UserModel, Role, ROLES } from "../models/User";

const router = Router();

// Capabilities grouped + labelled for the read-only "what this role can do"
// matrix on the user detail page (truthful to CAPABILITY_ROLES).
const PERMISSION_GROUPS: { group: string; caps: { cap: Capability; label: string }[] }[] = [
  { group: "Dashboard", caps: [{ cap: "view_dashboard", label: "View dashboard & reports" }] },
  { group: "Attendance", caps: [
    { cap: "mark_attendance", label: "Log attendance" },
    { cap: "submit_attendance", label: "Submit attendance" },
    { cap: "view_regularization", label: "View corrections" },
    { cap: "recommend_attendance", label: "Recommend corrections" },
    { cap: "approve_attendance", label: "Approve corrections" },
  ] },
  { group: "Overtime", caps: [
    { cap: "view_overtime", label: "View overtime" },
    { cap: "approve_overtime", label: "Approve overtime" },
  ] },
  { group: "Employees", caps: [
    { cap: "enroll_worker", label: "Enroll / edit employees" },
    { cap: "add_designation", label: "Add designations" },
    { cap: "delete_worker", label: "Delete employees" },
  ] },
  { group: "Org & sites", caps: [
    { cap: "view_org", label: "View branches & sites" },
    { cap: "manage_sites", label: "Manage sites" },
    { cap: "manage_org", label: "Manage branches & stations" },
  ] },
  { group: "Users", caps: [{ cap: "manage_users", label: "Manage user accounts" }] },
  { group: "Requests", caps: [
    { cap: "view_requests", label: "View requests" },
    { cap: "create_request", label: "Create requests" },
    { cap: "recommend_request", label: "Recommend requests" },
    { cap: "decide_request", label: "Approve / reject requests" },
  ] },
];

// A user's EFFECTIVE permissions (per-user overrides, else role) for the View page.
function permissionsForUser(user: { role: Role; capabilities?: string[] }) {
  return PERMISSION_GROUPS.map((g) => ({
    group: g.group,
    caps: g.caps.map((c) => ({ label: c.label, granted: userCan(user, c.cap) })),
  }));
}

// Each role's default-granted capabilities — the JS resets the form's checkboxes
// to these when the Role dropdown changes.
function roleDefaultsMap(roles: Role[]): Record<string, Capability[]> {
  const m: Record<string, Capability[]> = {};
  for (const r of roles) m[r] = ALL_CAPABILITIES.filter((c) => can(r, c));
  return m;
}

// Capability keys submitted by the form (multi-valued), validated.
function parseCapabilities(body: Record<string, unknown>): string[] {
  const raw = body.capabilities;
  const arr = Array.isArray(raw) ? raw : raw != null && raw !== "" ? [raw] : [];
  return arr.map(String).filter((c) => (ALL_CAPABILITIES as string[]).includes(c));
}

/** Resolve the capability set to store, with an anti-escalation guard:
 *  - the actor can only GRANT capabilities the actor itself has;
 *  - caps the actor can't touch (but the user already had) are preserved;
 *  - if the result equals the role's defaults exactly, store [] (follow role). */
function resolveCapabilities(actor: CurrentUser, role: Role, submitted: string[], existing: string[]): string[] {
  const roleDef = (ALL_CAPABILITIES.filter((c) => can(role, c)) as string[]);
  const actorCaps = ALL_CAPABILITIES.filter((c) => userCan(actor, c)) as string[];
  // Grantable = the target role's own defaults (never escalation) ∪ powers the
  // actor personally holds (delegation). You can't grant a power you lack.
  const grantable = new Set([...roleDef, ...actorCaps]);
  const preserved = existing.filter((c) => !grantable.has(c));
  const chosen = submitted.filter((c) => grantable.has(c));
  const final = [...new Set([...preserved, ...chosen])];
  const isDefault = final.length === roleDef.length && final.every((c) => roleDef.includes(c));
  return isDefault ? [] : final;
}

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

/** Roles the actor may assign/manage. Management (top): everyone; HR: below HR
 *  only (PM, Supervisor). */
function assignableRoles(actor: CurrentUser): Role[] {
  if (actor.role === "management") return [...ROLES];
  if (actor.role === "hr") return ["pm", "supervisor"];
  return [];
}
function canManageRole(actor: CurrentUser, role: string): boolean {
  return (assignableRoles(actor) as string[]).includes(role);
}

function parseSiteIds(body: Record<string, unknown>): string[] {
  const raw = body.assignedSiteIds;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map(String).filter((s) => Types.ObjectId.isValid(s));
}

/** Validates role↔site rules. Returns an error string or null.
 *  Top admins (Super Admin/Management/HR) cover all sites (none stored);
 *  PM and Supervisor must have at least one site. */
function validateSites(role: Role, siteIds: string[]): string | null {
  if (seesAllSites(role)) return null;
  return siteIds.length >= 1 ? null : `Select at least one site for a ${roleLabel(role)}.`;
}

async function siteList() {
  return ProjectSiteModel.find().sort({ name: 1 }).lean();
}

// ---- Ledger list ----
router.get("/users", requireCapability("manage_users"), async (req: Request, res: Response) => {
  const actor = req.currentUser!;
  const authorityRoles = assignableRoles(actor); // Management: all; HR: pm/supervisor
  const q = String(req.query.q ?? "").trim();
  const roleParam = String(req.query.role ?? "");
  const selectedRole = (authorityRoles as string[]).includes(roleParam) ? roleParam : "";

  const [allUsers, sites] = await Promise.all([
    UserModel.find({ role: { $in: authorityRoles } }).sort({ role: 1, name: 1 }).lean(),
    siteList(),
  ]);
  const siteNameById = new Map(sites.map((s) => [String(s._id), `${s.name} (${s.code})`]));

  let listed = allUsers;
  if (selectedRole) listed = listed.filter((u) => u.role === selectedRole);
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    listed = listed.filter((u) => rx.test(u.name) || rx.test(u.email));
  }
  const summary = {
    total: allUsers.length,
    active: allUsers.filter((u) => u.active).length,
    inactive: allUsers.filter((u) => !u.active).length,
    pms: allUsers.filter((u) => u.role === "pm").length,
    supervisors: allUsers.filter((u) => u.role === "supervisor").length,
  };

  res.render("users/index", {
    title: "Users & Roles · " + res.locals.company,
    active: "/users",
    users: listed,
    siteNameById,
    summary,
    q,
    selectedRole,
    roles: authorityRoles,
    selfId: actor.id,
  });
});

// ---- New ----
router.get("/users/new", requireCapability("manage_users"), async (req: Request, res: Response) => {
  const actor = req.currentUser!;
  const roles = assignableRoles(actor);
  const roleDefaults = roleDefaultsMap(roles);
  const actorCaps = ALL_CAPABILITIES.filter((c) => userCan(actor, c));
  const initialRole = roles[0];
  res.render("users/form", {
    title: "Add user · " + res.locals.company,
    active: "/users",
    mode: "new",
    roles,
    permGroups: PERMISSION_GROUPS,
    roleDefaults,
    actorCaps,
    grantable: [...new Set([...(roleDefaults[initialRole] || []), ...actorCaps])],
    checkedCaps: roleDefaults[initialRole] || [],
    sites: await siteList(),
    user: null,
  });
});

router.post("/users", requireCapability("manage_users"), async (req: Request, res: Response) => {
  const actor = req.currentUser!;
  const name = String(req.body.name ?? "").trim();
  const email = String(req.body.email ?? "").toLowerCase().trim();
  const phone = String(req.body.phone ?? "").trim() || null;
  const password = String(req.body.password ?? "");
  const role = String(req.body.role ?? "") as Role;
  const siteIds = parseSiteIds(req.body);

  if (!name || !email || !password) {
    flash(req, "danger", "Name, email, and password are required.");
    return res.redirect("/users/new");
  }
  if (!canManageRole(actor, role)) {
    flash(req, "danger", "You cannot assign that role.");
    return res.redirect("/users/new");
  }
  const siteErr = validateSites(role, siteIds);
  if (siteErr) {
    flash(req, "danger", siteErr);
    return res.redirect("/users/new");
  }
  const assignedSiteIds = seesAllSites(role) ? [] : siteIds.map((s) => new Types.ObjectId(s));
  const capabilities = resolveCapabilities(actor, role, parseCapabilities(req.body), []);
  try {
    await UserModel.create({ name, email, phone, passwordHash: await hashPassword(password), role, assignedSiteIds, capabilities, active: true });
    flash(req, "success", `User ${name} created.`);
    res.redirect("/users");
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? "That email is already in use." : "Could not create user.");
    res.redirect("/users/new");
  }
});

// ---- View (read-only detail + role permission matrix) ----
router.get("/users/:id", requireCapability("manage_users"), async (req: Request, res: Response) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    flash(req, "danger", "User not found.");
    return res.redirect("/users");
  }
  const user = await UserModel.findById(req.params.id).lean();
  if (!user || !canManageRole(req.currentUser!, user.role)) {
    flash(req, "danger", "User not found or out of your authority.");
    return res.redirect("/users");
  }
  const sites = await siteList();
  const siteNameById = new Map(sites.map((s) => [String(s._id), `${s.name} (${s.code})`]));
  const siteNames = (user.assignedSiteIds || []).map((id) => siteNameById.get(String(id)) || "?");
  res.render("users/view", {
    title: user.name + " · " + res.locals.company,
    active: "/users",
    user,
    siteList: siteNames,
    permissions: permissionsForUser(user as { role: Role; capabilities?: string[] }),
    customized: !!(user.capabilities && user.capabilities.length),
    isSelf: String(user._id) === req.currentUser!.id,
  });
});

// ---- Edit ----
router.get("/users/:id/edit", requireCapability("manage_users"), async (req: Request, res: Response) => {
  const user = await UserModel.findById(req.params.id).lean();
  if (!user || !canManageRole(req.currentUser!, user.role)) {
    flash(req, "danger", "User not found or out of your authority.");
    return res.redirect("/users");
  }
  const actor = req.currentUser!;
  const roles = assignableRoles(actor);
  const roleDefaults = roleDefaultsMap(roles);
  const actorCaps = ALL_CAPABILITIES.filter((c) => userCan(actor, c));
  const checkedCaps = (user.capabilities && user.capabilities.length) ? user.capabilities : (roleDefaults[user.role] || []);
  res.render("users/form", {
    title: "Edit user · " + res.locals.company,
    active: "/users",
    mode: "edit",
    roles,
    permGroups: PERMISSION_GROUPS,
    roleDefaults,
    actorCaps,
    grantable: [...new Set([...(roleDefaults[user.role] || []), ...actorCaps])],
    checkedCaps,
    sites: await siteList(),
    user,
    isSelf: String(user._id) === req.currentUser!.id,
  });
});

router.post("/users/:id", requireCapability("manage_users"), async (req: Request, res: Response) => {
  const actor = req.currentUser!;
  const user = await UserModel.findById(req.params.id);
  if (!user || !canManageRole(actor, user.role)) {
    flash(req, "danger", "User not found or out of your authority.");
    return res.redirect("/users");
  }
  const isSelf = String(user._id) === actor.id;

  const name = String(req.body.name ?? "").trim();
  const email = String(req.body.email ?? "").toLowerCase().trim();
  // Self-lockout guard: you cannot change your own role or active flag.
  const role = isSelf ? (user.role as Role) : (String(req.body.role ?? "") as Role);
  if (!name || !email) {
    flash(req, "danger", "Name and email are required.");
    return res.redirect(`/users/${req.params.id}/edit`);
  }
  if (!canManageRole(actor, role)) {
    flash(req, "danger", "You cannot assign that role.");
    return res.redirect(`/users/${req.params.id}/edit`);
  }
  const siteIds = parseSiteIds(req.body);
  const siteErr = validateSites(role, siteIds);
  if (siteErr) {
    flash(req, "danger", siteErr);
    return res.redirect(`/users/${req.params.id}/edit`);
  }

  user.name = name;
  user.email = email;
  user.phone = String(req.body.phone ?? "").trim() || null;
  user.role = role;
  user.assignedSiteIds = seesAllSites(role) ? [] : (siteIds.map((s) => new Types.ObjectId(s)) as never);
  user.capabilities = resolveCapabilities(actor, role, parseCapabilities(req.body), (user.capabilities ?? []).map(String)) as never;
  if (!isSelf && typeof req.body.active !== "undefined") user.active = req.body.active === "on" || req.body.active === "true";
  const newPassword = String(req.body.password ?? "");
  if (newPassword) user.passwordHash = await hashPassword(newPassword);

  try {
    await user.save();
    flash(req, "success", "User updated.");
    res.redirect("/users");
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? "That email is already in use." : "Could not update user.");
    res.redirect(`/users/${req.params.id}/edit`);
  }
});

// ---- Activate / deactivate ----
router.post("/users/:id/toggle", requireCapability("manage_users"), async (req: Request, res: Response) => {
  const actor = req.currentUser!;
  const user = await UserModel.findById(req.params.id);
  if (!user || !canManageRole(actor, user.role)) {
    flash(req, "danger", "User not found or out of your authority.");
    return res.redirect("/users");
  }
  if (String(user._id) === actor.id) {
    flash(req, "danger", "You cannot deactivate your own account.");
    return res.redirect("/users");
  }
  user.active = !user.active;
  await user.save();
  flash(req, "success", `User ${user.active ? "activated" : "deactivated"}.`);
  res.redirect("/users");
});

export default router;
