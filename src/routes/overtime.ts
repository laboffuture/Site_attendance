import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { canUseSite, siteScopeFilter } from "../lib/scope";
import { round2 } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

const STATUSES = ["pending", "recommended", "approved", "rejected"];
const FILTERS = ["pending", "recommended", "approved", "rejected", "all"] as const;

// Queue is visible to Management/HR/PM (PM view-only). Scoped to the user's sites.
// Flow: OT auto-detected (pending) → HR recommends → Management approves/closes.
router.get("/overtime", requireCapability("view_overtime"), async (req: Request, res: Response) => {
  const filter = FILTERS.includes(req.query.status as never) ? (req.query.status as string) : "pending";

  const scope = siteScopeFilter(req.currentUser!);
  const query: Record<string, unknown> = { ...scope };
  query["overtime.status"] = filter === "all" ? { $in: STATUSES } : filter;

  const [records, countAgg] = await Promise.all([
    AttendanceModel.find(query).sort({ siteName: 1, date: -1 }).limit(500).lean(),
    AttendanceModel.aggregate([
      { $match: { ...scope, "overtime.status": { $in: STATUSES } } },
      { $group: { _id: "$overtime.status", n: { $sum: 1 } } },
    ]),
  ]);
  const byStatus = new Map<string, number>(countAgg.map((c) => [c._id as string, c.n as number]));

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
    counts: {
      pending: byStatus.get("pending") ?? 0,
      recommended: byStatus.get("recommended") ?? 0,
      approved: byStatus.get("approved") ?? 0,
      rejected: byStatus.get("rejected") ?? 0,
    },
    canRecommend: res.locals.can("recommend_overtime"),
    canApprove: res.locals.can("approve_overtime"),
  });
});

// Recommend / raise (HR): pending → recommended.
router.post("/overtime/:id/recommend", requireCapability("recommend_overtime"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.id);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) {
    flash(req, "danger", "Overtime record not found.");
    return res.redirect("/overtime");
  }
  if (rec.overtime.status !== "pending") {
    flash(req, "danger", "Only a pending overtime record can be recommended.");
    return res.redirect("/overtime");
  }
  rec.overtime.status = "recommended";
  rec.overtime.recommendedBy = new Types.ObjectId(req.currentUser!.id);
  rec.overtime.recommendedAt = new Date();
  await rec.save();
  flash(req, "success", `Recommended OT for ${rec.workerName} — awaiting Management approval.`);
  res.redirect("/overtime?status=recommended");
});

// Approve / adjust — Management closes (from pending or recommended).
router.post("/overtime/:id/approve", requireCapability("approve_overtime"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.id);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) {
    flash(req, "danger", "Overtime record not found.");
    return res.redirect("/overtime");
  }
  if (!["pending", "recommended"].includes(rec.overtime.status)) {
    flash(req, "danger", "Overtime record not found or already decided.");
    return res.redirect("/overtime");
  }
  // Approve up to the computed OT, never more than was actually worked. A blank /
  // invalid entry approves the full computed hours; an entry above it is clamped.
  const raw = Number(req.body.approvedHours);
  const computed = rec.overtime.computedHours;
  const approvedHours = Number.isFinite(raw) && raw >= 0 ? round2(Math.min(raw, computed)) : computed;
  const clamped = Number.isFinite(raw) && raw > computed;
  rec.overtime = {
    computedHours: rec.overtime.computedHours,
    status: "approved",
    approvedHours,
    recommendedBy: rec.overtime.recommendedBy ?? null,
    recommendedAt: rec.overtime.recommendedAt ?? null,
    approvedBy: new Types.ObjectId(req.currentUser!.id),
    approvedAt: new Date(),
    notes: String(req.body.notes ?? "").trim() || null,
  };
  await rec.save();
  flash(req, "success", `Approved ${approvedHours}h OT for ${rec.workerName}.${clamped ? ` (capped at the ${computed}h computed.)` : ""}`);
  res.redirect("/overtime");
});

// Reject — Management closes (from pending or recommended).
router.post("/overtime/:id/reject", requireCapability("approve_overtime"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.id);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) {
    flash(req, "danger", "Overtime record not found.");
    return res.redirect("/overtime");
  }
  if (!["pending", "recommended"].includes(rec.overtime.status)) {
    flash(req, "danger", "Overtime record not found or already decided.");
    return res.redirect("/overtime");
  }
  rec.overtime = {
    computedHours: rec.overtime.computedHours,
    status: "rejected",
    approvedHours: 0,
    recommendedBy: rec.overtime.recommendedBy ?? null,
    recommendedAt: rec.overtime.recommendedAt ?? null,
    approvedBy: new Types.ObjectId(req.currentUser!.id),
    approvedAt: new Date(),
    notes: String(req.body.notes ?? "").trim() || null,
  };
  await rec.save();
  flash(req, "success", `Rejected OT for ${rec.workerName}.`);
  res.redirect("/overtime");
});

export default router;
