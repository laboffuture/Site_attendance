import { Router, Request, Response } from "express";

import { requireCapability } from "../auth/middleware";
import { siteScopeFilter } from "../lib/scope";
import { AttendanceModel } from "../models/Attendance";

const router = Router();

const FILTERS = ["pending", "approved", "rejected", "all"] as const;

// Read-only overtime ledger. Approval / rejection now happens through the daily
// Regularization chain — HR's day approval subsumes that day's pending OT — so
// this page only reports status. Visible to Management/HR/PM, scoped to sites.
router.get("/overtime", requireCapability("view_overtime"), async (req: Request, res: Response) => {
  const filter = FILTERS.includes(req.query.status as never)
    ? (req.query.status as string)
    : "pending";

  const query: Record<string, unknown> = { ...siteScopeFilter(req.currentUser!) };
  if (filter === "all") {
    query["overtime.status"] = { $in: ["pending", "approved", "rejected"] };
  } else {
    query["overtime.status"] = filter;
  }

  const records = await AttendanceModel.find(query)
    .sort({ date: -1, createdAt: -1 })
    .limit(500)
    .lean();

  res.render("overtime/index", {
    title: "Overtime · " + res.locals.company,
    active: "/overtime",
    records,
    filter,
  });
});

export default router;
