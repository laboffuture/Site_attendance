import { RequestHandler } from "express";

import * as db from "../db";
import { UserModel, Role } from "../models/User";
import { Capability, can } from "./permissions";

/**
 * Loads the signed-in user fresh from the DB on each request (so role/scope
 * changes take effect immediately) and exposes it to handlers and templates.
 * Also wires res.locals.can() for capability-based rendering in views.
 */
export const loadCurrentUser: RequestHandler = async (req, res, next) => {
  try {
    if (req.session.userId && db.dbReady) {
      const u = await UserModel.findById(req.session.userId);
      if (u && u.active) {
        req.currentUser = {
          id: String(u._id),
          name: u.name,
          email: u.email,
          role: u.role as Role,
          assignedSiteIds: (u.assignedSiteIds ?? []).map(String),
        };
        res.locals.currentUser = req.currentUser;
        res.locals.can = (cap: Capability) => can(req.currentUser!.role, cap);
      } else {
        // Account deleted or deactivated mid-session → drop the session.
        req.session.destroy(() => undefined);
      }
    }
  } catch (err) {
    console.warn("loadCurrentUser failed:", (err as Error).message);
  }
  next();
};

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.currentUser) return res.redirect("/");
  next();
};

function deny(res: Parameters<RequestHandler>[1]): void {
  res
    .status(403)
    .render("error", {
      title: "Access denied",
      active: "",
      code: 403,
      message: "You do not have access to this page.",
    });
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    if (!req.currentUser) return res.redirect("/");
    if (!roles.includes(req.currentUser.role)) return deny(res);
    next();
  };
}

export function requireCapability(capability: Capability): RequestHandler {
  return (req, res, next) => {
    if (!req.currentUser) return res.redirect("/");
    if (!can(req.currentUser.role, capability)) return deny(res);
    next();
  };
}
