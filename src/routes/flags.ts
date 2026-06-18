import { Router, Request, Response } from "express";

import { requireCapability } from "../auth/middleware";
import { canUseSite, flagScopeFilter } from "../lib/scope";
import { FlagEventModel } from "../models/FlagEvent";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

// Flagged events are visible to PE/Supervisor and above (view_dashboard),
// scoped to the site where the attempt happened.
router.get("/flags", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const showResolved = req.query.status === "resolved";
  const flags = await FlagEventModel.find({ ...flagScopeFilter(req.currentUser!), resolved: showResolved })
    .sort({ timestamp: -1 })
    .limit(500)
    .lean();
  res.render("flags/index", {
    title: "Flagged events · " + res.locals.company,
    active: "/flags",
    flags,
    showResolved,
  });
});

router.post("/flags/:id/resolve", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const flag = await FlagEventModel.findById(req.params.id);
  if (!flag) {
    flash(req, "danger", "Flag not found.");
    return res.redirect("/flags");
  }
  // Only act on flags within the user's site scope.
  if (flag.attemptedSiteId && !canUseSite(req.currentUser!, String(flag.attemptedSiteId))) {
    return res.status(403).render("error", { title: "Access denied", active: "", code: 403, message: "Out of your site scope." });
  }
  flag.resolved = true;
  await flag.save();
  flash(req, "success", "Flag marked resolved.");
  res.redirect("/flags");
});

export default router;
