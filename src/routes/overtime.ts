import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { siteScopeFilter } from "../lib/scope";
import { round2 } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

const FILTERS = ["pending", "approved", "rejected", "all"] as const;

// Queue is visible to Management/HR/PM (PM view-only). Scoped to the user's sites.
// HR + Management approve / adjust / reject OT here; a Regularization day-approval
// also clears that day's pending OT in bulk.
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
    .sort({ siteName: 1, date: -1 })
    .limit(500)
    .lean();

  // Group by site so Management scans per location with a clear breaker, and
  // can approve/decline a whole site's OT at a glance.
  type Rec = (typeof records)[number];
  const bySite = new Map<string, { siteName: string; otTotal: number; records: Rec[] }>();
  for (const r of records) {
    const key = String(r.siteId);
    let g = bySite.get(key);
    if (!g) { g = { siteName: r.siteName, otTotal: 0, records: [] }; bySite.set(key, g); }
    g.records.push(r);
    g.otTotal += r.overtime?.computedHours ?? 0;
  }
  const groups = [...bySite.values()]
    .map((g) => ({ ...g, otTotal: round2(g.otTotal) }))
    .sort((a, b) => a.siteName.localeCompare(b.siteName));

  res.render("overtime/index", {
    title: "Overtime · " + res.locals.company,
    active: "/overtime",
    groups,
    total: records.length,
    filter,
    canApprove: res.locals.can("approve_overtime"),
  });
});

// Approve / adjust (Management/HR only).
router.post("/overtime/:id/approve", requireCapability("approve_overtime"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.id);
  if (!rec || rec.overtime.status === "none") {
    flash(req, "danger", "Overtime record not found.");
    return res.redirect("/overtime");
  }
  const raw = Number(req.body.approvedHours);
  const approvedHours = Number.isFinite(raw) && raw >= 0 ? round2(raw) : rec.overtime.computedHours;
  rec.overtime = {
    computedHours: rec.overtime.computedHours,
    status: "approved",
    approvedHours,
    approvedBy: new Types.ObjectId(req.currentUser!.id),
    approvedAt: new Date(),
    notes: String(req.body.notes ?? "").trim() || null,
  };
  await rec.save();
  flash(req, "success", `Approved ${approvedHours}h OT for ${rec.workerName}.`);
  res.redirect("/overtime");
});

// Reject (Management/HR only).
router.post("/overtime/:id/reject", requireCapability("approve_overtime"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.id);
  if (!rec || rec.overtime.status === "none") {
    flash(req, "danger", "Overtime record not found.");
    return res.redirect("/overtime");
  }
  rec.overtime = {
    computedHours: rec.overtime.computedHours,
    status: "rejected",
    approvedHours: 0,
    approvedBy: new Types.ObjectId(req.currentUser!.id),
    approvedAt: new Date(),
    notes: String(req.body.notes ?? "").trim() || null,
  };
  await rec.save();
  flash(req, "success", `Rejected OT for ${rec.workerName}.`);
  res.redirect("/overtime");
});

export default router;
