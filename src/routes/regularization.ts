import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { canUseSite, siteScopeFilter } from "../lib/scope";
import { istHM } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

const TABS: Record<string, string[]> = {
  submitted: ["submitted"],
  recommended: ["recommended"],
  approved: ["approved"],
  rejected: ["rejected"],
};

// ---- Queue: site-days grouped by status (scoped) + status counters ----
router.get("/regularization", requireCapability("view_regularization"), async (req: Request, res: Response) => {
  const tab = TABS[String(req.query.tab)] ? String(req.query.tab) : "submitted";
  const scope = siteScopeFilter(req.currentUser!);
  const [days, countAgg] = await Promise.all([
    AttendanceModel.aggregate([
      { $match: { ...scope, attendanceStatus: { $in: TABS[tab] } } },
      { $group: { _id: { siteId: "$siteId", siteName: "$siteName", date: "$date" }, n: { $sum: 1 }, ot: { $sum: "$overtime.computedHours" } } },
      { $sort: { "_id.date": -1, "_id.siteName": 1 } },
      { $limit: 300 },
    ]),
    AttendanceModel.aggregate([
      { $match: { ...scope, attendanceStatus: { $in: ["submitted", "recommended", "approved", "rejected"] } } },
      { $group: { _id: "$attendanceStatus", n: { $sum: 1 } } },
    ]),
  ]);
  const byStatus = new Map<string, number>(countAgg.map((c) => [c._id as string, c.n as number]));
  res.render("regularization/index", {
    title: "Attendance corrections · " + res.locals.company,
    active: "/regularization",
    tab,
    days: days.map((d) => ({ siteId: String(d._id.siteId), siteName: d._id.siteName, date: d._id.date, n: d.n, ot: d.ot })),
    counts: {
      submitted: byStatus.get("submitted") ?? 0,
      recommended: byStatus.get("recommended") ?? 0,
      approved: byStatus.get("approved") ?? 0,
      rejected: byStatus.get("rejected") ?? 0,
    },
  });
});

// ---- One site-day ----
router.get("/regularization/:siteId/:date", requireCapability("view_regularization"), async (req: Request, res: Response) => {
  const { siteId, date } = req.params;
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(req.currentUser!, siteId) || !DATE_RE.test(date)) {
    flash(req, "danger", "Not found or out of scope.");
    return res.redirect("/regularization");
  }
  const records = await AttendanceModel.find({ siteId, date }).sort({ workerName: 1 }).lean();
  const rows = records.map((r) => ({
    id: String(r._id), workerName: r.workerName, empRegNo: r.empRegNo,
    inHM: istHM(r.inTime ?? null), outHM: istHM(r.outTime ?? null),
    totalHours: r.totalHours, otHours: r.overtime?.computedHours ?? 0,
    status: r.attendanceStatus, remark: r.dailyRemark ?? "", rejectReason: r.rejectReason ?? "",
  }));
  const status = records[0]?.attendanceStatus ?? "scanned";
  res.render("regularization/day", {
    title: "Regularization · " + res.locals.company, active: "/regularization",
    siteName: records[0]?.siteName ?? "", siteId, date, rows, status,
    canRecommend: res.locals.can("recommend_attendance"),
    canApprove: res.locals.can("approve_attendance"),
    canReject: res.locals.can("view_regularization"),
  });
});

async function transition(req: Request, res: Response, from: string, to: string, set: Record<string, unknown>) {
  const { siteId, date } = req.params;
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(req.currentUser!, siteId) || !DATE_RE.test(date)) {
    return res.status(403).render("error", { title: "Access denied", active: "", code: 403, message: "Out of your site scope." });
  }
  const r = await AttendanceModel.updateMany({ siteId, date, attendanceStatus: from }, { $set: set });
  flash(req, "success", `${r.modifiedCount} record(s) ${to}.`);
  res.redirect(`/regularization/${siteId}/${date}`);
}

// ---- PM recommend: submitted → recommended ----
router.post("/regularization/:siteId/:date/recommend", requireCapability("recommend_attendance"), (req, res) =>
  transition(req, res, "submitted", "recommended", {
    attendanceStatus: "recommended",
    recommendedBy: new Types.ObjectId(req.currentUser!.id),
    recommendedAt: new Date(),
  }),
);

// ---- HR approve: recommended → approved (+ subsume OT) ----
router.post("/regularization/:siteId/:date/approve", requireCapability("approve_attendance"), async (req: Request, res: Response) => {
  const { siteId, date } = req.params;
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(req.currentUser!, siteId) || !DATE_RE.test(date)) {
    return res.status(403).render("error", { title: "Access denied", active: "", code: 403, message: "Out of your site scope." });
  }
  const now = new Date();
  const by = new Types.ObjectId(req.currentUser!.id);
  await AttendanceModel.updateMany(
    { siteId, date, attendanceStatus: "recommended" },
    { $set: { attendanceStatus: "approved", decidedBy: by, decidedAt: now } },
  );
  // Subsume OT approval: approving the day closes that day's open OT (pending or
  // HR-recommended) in bulk — Management is closing it here too.
  await AttendanceModel.updateMany(
    { siteId, date, attendanceStatus: "approved", "overtime.computedHours": { $gt: 0 }, "overtime.status": { $in: ["pending", "recommended"] } },
    { $set: { "overtime.status": "approved", "overtime.approvedBy": by, "overtime.approvedAt": now } },
  );
  flash(req, "success", "Day approved.");
  res.redirect(`/regularization/${siteId}/${date}`);
});

// ---- Per-worker reject (either step) ----
router.post("/regularization/worker/:attendanceId/reject", requireCapability("view_regularization"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.attendanceId);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) {
    flash(req, "danger", "Record not found.");
    return res.redirect("/regularization");
  }
  rec.attendanceStatus = "rejected";
  rec.rejectReason = String(req.body.reason ?? "").trim() || null;
  rec.decidedBy = new Types.ObjectId(req.currentUser!.id);
  rec.decidedAt = new Date();
  if (rec.overtime.computedHours > 0) {
    rec.overtime.status = "rejected";
    rec.overtime.approvedBy = new Types.ObjectId(req.currentUser!.id);
    rec.overtime.approvedAt = new Date();
  }
  await rec.save();
  flash(req, "success", `Rejected ${rec.workerName}.`);
  res.redirect(`/regularization/${rec.siteId}/${rec.date}`);
});

export default router;
