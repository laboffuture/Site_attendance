import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import type { CurrentUser } from "../auth/types";
import { hashPassword } from "../auth/password";
import { isDuplicateKeyError } from "../lib/validate";
import { ProjectSiteModel } from "../models/ProjectSite";
import { UserModel, Role, ROLES } from "../models/User";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

/** Roles the actor may assign/manage. Management: all; HR: below HR only. */
function assignableRoles(actor: CurrentUser): Role[] {
  if (actor.role === "management") return [...ROLES];
  if (actor.role === "hr") return ["pm", "pe", "supervisor"];
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
 *  PM and Supervisor may cover one OR more sites; PE is tied to exactly one. */
function validateSites(role: Role, siteIds: string[]): string | null {
  if (role === "management" || role === "hr") return null; // all sites → none stored
  if (role === "pm" || role === "supervisor") {
    return siteIds.length >= 1 ? null : `Select at least one site for a ${role.toUpperCase()}.`;
  }
  return siteIds.length === 1 ? null : "Select exactly one site for a PE.";
}

async function siteList() {
  return ProjectSiteModel.find().sort({ name: 1 }).lean();
}

// ---- List ----
router.get("/users", requireCapability("manage_users"), async (req: Request, res: Response) => {
  const roleFilter = assignableRoles(req.currentUser!);
  // Management sees everyone; HR sees only the roles it can manage.
  const query = req.currentUser!.role === "management" ? {} : { role: { $in: roleFilter } };
  const [users, sites] = await Promise.all([
    UserModel.find(query).sort({ role: 1, name: 1 }).lean(),
    siteList(),
  ]);
  const siteNameById = new Map(sites.map((s) => [String(s._id), `${s.name} (${s.code})`]));
  res.render("users/index", {
    title: "Users & Roles · " + res.locals.company,
    active: "/users",
    users,
    siteNameById,
    selfId: req.currentUser!.id,
  });
});

// ---- New ----
router.get("/users/new", requireCapability("manage_users"), async (req: Request, res: Response) => {
  res.render("users/form", {
    title: "Add user · " + res.locals.company,
    active: "/users",
    mode: "new",
    roles: assignableRoles(req.currentUser!),
    sites: await siteList(),
    user: null,
  });
});

router.post("/users", requireCapability("manage_users"), async (req: Request, res: Response) => {
  const actor = req.currentUser!;
  const name = String(req.body.name ?? "").trim();
  const email = String(req.body.email ?? "").toLowerCase().trim();
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
  const assignedSiteIds = role === "management" || role === "hr" ? [] : siteIds.map((s) => new Types.ObjectId(s));
  try {
    await UserModel.create({ name, email, passwordHash: await hashPassword(password), role, assignedSiteIds, active: true });
    flash(req, "success", `User ${name} created.`);
    res.redirect("/users");
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? "That email is already in use." : "Could not create user.");
    res.redirect("/users/new");
  }
});

// ---- Edit ----
router.get("/users/:id/edit", requireCapability("manage_users"), async (req: Request, res: Response) => {
  const user = await UserModel.findById(req.params.id).lean();
  if (!user || !canManageRole(req.currentUser!, user.role)) {
    flash(req, "danger", "User not found or out of your authority.");
    return res.redirect("/users");
  }
  res.render("users/form", {
    title: "Edit user · " + res.locals.company,
    active: "/users",
    mode: "edit",
    roles: assignableRoles(req.currentUser!),
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
  user.role = role;
  user.assignedSiteIds = role === "management" || role === "hr" ? [] : (siteIds.map((s) => new Types.ObjectId(s)) as never);
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
