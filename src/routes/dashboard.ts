import { Router, Request, Response } from "express";

import { requireAuth } from "../auth/middleware";

const router = Router();

router.get("/dashboard", requireAuth, (req: Request, res: Response) => {
  const u = req.currentUser!;
  let scopeLabel: string;
  if (u.role === "management" || u.role === "hr") {
    scopeLabel = "All branches & sites";
  } else if (u.role === "pm") {
    scopeLabel = `${u.assignedSiteIds.length} assigned site(s)`;
  } else {
    scopeLabel = "Own site";
  }

  res.render("dashboard", {
    title: "Dashboard · " + res.locals.company,
    active: "/dashboard",
    scopeLabel,
  });
});

export default router;
