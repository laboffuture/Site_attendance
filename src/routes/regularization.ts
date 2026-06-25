import { Router, Request, Response } from "express";
import { Types, type HydratedDocument } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { reckonHours } from "../lib/attendance";
import { canUseSite, siteScopeFilter } from "../lib/scope";
import { istHM, istDateTime } from "../lib/time";
import { AttendanceModel, type Attendance } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    shiftType: r.shiftType ?? "day",
    outSource: r.outSource ?? null, voided: r.voided ?? false, verifiedAt: r.verifiedAt ?? null, punches: r.sessions?.length ?? 0,
  }));
  const status = records[0]?.attendanceStatus ?? "scanned";
  // HR-only: active workers assigned to this site who have no record yet today —
  // these are the ones HR can add a manual day for (someone who never scanned).
  let addableWorkers: { id: string; name: string; empRegNo: string }[] = [];
  if (res.locals.can("correct_attendance")) {
    const present = new Set(records.map((r) => String(r.workerId)));
    const ws = await WorkerModel.find({ siteId, status: "active" }).select("name empRegNo").sort({ name: 1 }).lean();
    addableWorkers = ws.filter((w) => !present.has(String(w._id))).map((w) => ({ id: String(w._id), name: w.name, empRegNo: w.empRegNo }));
  }
  res.render("regularization/day", {
    title: "Regularization · " + res.locals.company, active: "/regularization",
    siteName: records[0]?.siteName ?? "", siteId, date, rows, status,
    canRecommend: res.locals.can("recommend_attendance"),
    canApprove: res.locals.can("approve_attendance"),
    canReject: res.locals.can("view_regularization"),
    canCorrect: res.locals.can("correct_attendance"),
    addableWorkers,
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

// ===================== HR-only corrections =====================
// HR fixes a missing/wrong punch; the day re-enters the chain and Management
// closes it (gated by correct_attendance = HR only). Every edit is audited.

/** Append an audit entry + mark the record as HR-touched. */
function pushCorrection(rec: HydratedDocument<Attendance>, field: string, oldVal: unknown, newVal: unknown, userId: string, reason: string | null): void {
  rec.corrections.push({ field, oldValue: oldVal == null ? null : String(oldVal), newValue: newVal == null ? null : String(newVal), by: new Types.ObjectId(userId), at: new Date(), reason });
  rec.source = "manual";
  rec.markedBy = new Types.ObjectId(userId);
}

/** Recompute hours via the shared flat reckoner once both In and Out are present. */
async function recompute(rec: HydratedDocument<Attendance>): Promise<void> {
  if (rec.inTime && rec.outTime) {
    const site = await ProjectSiteModel.findById(rec.siteId).select("lunchHours").lean();
    const lunch = typeof site?.lunchHours === "number" ? site.lunchHours : 1;
    const h = reckonHours(rec.inTime, rec.outTime, lunch);
    rec.totalHours = h.totalHours;
    rec.standardHours = h.standardHours;
    rec.breakHours = lunch;
    rec.overtime.computedHours = h.overtimeHours;
    rec.overtime.status = h.overtimeHours > 0 ? "pending" : "none";
  }
}

/** HR's correction is a recommendation; Management closes it via the approve route. */
function reRecommend(rec: HydratedDocument<Attendance>, userId: string): void {
  rec.attendanceStatus = "recommended";
  rec.recommendedBy = new Types.ObjectId(userId);
  rec.recommendedAt = new Date();
}

// Fix In/Out time and/or shiftType on one record.
router.post("/regularization/worker/:attendanceId/correct", requireCapability("correct_attendance"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.attendanceId);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) {
    flash(req, "danger", "Record not found.");
    return res.redirect("/regularization");
  }
  const uid = req.currentUser!.id;
  const reason = String(req.body.reason ?? "").trim() || null;
  const inHM = String(req.body.inHM ?? "").trim();
  const outHM = String(req.body.outHM ?? "").trim();
  const shiftType = String(req.body.shiftType ?? "").trim();
  let touched = false;
  if (inHM && HM_RE.test(inHM)) { pushCorrection(rec, "inTime", istHM(rec.inTime), inHM, uid, reason); rec.inTime = istDateTime(rec.date, inHM); touched = true; }
  if (outHM && HM_RE.test(outHM)) { pushCorrection(rec, "outTime", istHM(rec.outTime ?? null), outHM, uid, reason); rec.outTime = istDateTime(rec.date, outHM); rec.outSource = "hr-filled"; touched = true; }
  if (shiftType && ["day", "night", "sunday"].includes(shiftType)) { pushCorrection(rec, "shiftType", rec.shiftType, shiftType, uid, reason); rec.shiftType = shiftType as Attendance["shiftType"]; touched = true; }
  if (!touched) { flash(req, "danger", "Nothing to correct — enter a time or shift."); return res.redirect(`/regularization/${rec.siteId}/${rec.date}`); }
  await recompute(rec);
  reRecommend(rec, uid);
  await rec.save();
  flash(req, "success", `Corrected ${rec.workerName}.`);
  res.redirect(`/regularization/${rec.siteId}/${rec.date}`);
});

// Void a bogus record (excluded from pay).
router.post("/regularization/worker/:attendanceId/void", requireCapability("correct_attendance"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.attendanceId);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) {
    flash(req, "danger", "Record not found.");
    return res.redirect("/regularization");
  }
  const uid = req.currentUser!.id;
  rec.voided = true;
  rec.voidedBy = new Types.ObjectId(uid);
  rec.voidedAt = new Date();
  rec.voidReason = String(req.body.reason ?? "").trim() || null;
  pushCorrection(rec, "void", "false", "true", uid, rec.voidReason);
  await rec.save();
  flash(req, "success", `Voided ${rec.workerName}.`);
  res.redirect(`/regularization/${rec.siteId}/${rec.date}`);
});

// Mark an ambiguous record verified (acknowledged).
router.post("/regularization/worker/:attendanceId/verify", requireCapability("correct_attendance"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.attendanceId);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) {
    flash(req, "danger", "Record not found.");
    return res.redirect("/regularization");
  }
  const uid = req.currentUser!.id;
  rec.verifiedBy = new Types.ObjectId(uid);
  rec.verifiedAt = new Date();
  rec.verifyNote = String(req.body.note ?? "").trim() || null;
  pushCorrection(rec, "verify", null, "verified", uid, rec.verifyNote);
  await rec.save();
  flash(req, "success", `Verified ${rec.workerName}.`);
  res.redirect(`/regularization/${rec.siteId}/${rec.date}`);
});

// Create a manual day for a worker who never scanned.
router.post("/regularization/:siteId/:date/create", requireCapability("correct_attendance"), async (req: Request, res: Response) => {
  const { siteId, date } = req.params;
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(req.currentUser!, siteId) || !DATE_RE.test(date)) {
    flash(req, "danger", "Out of scope.");
    return res.redirect("/regularization");
  }
  const workerId = String(req.body.workerId ?? "");
  const inHM = String(req.body.inHM ?? "").trim();
  const outHM = String(req.body.outHM ?? "").trim();
  const shiftType = ["day", "night", "sunday"].includes(String(req.body.shiftType)) ? String(req.body.shiftType) : "day";
  const reason = String(req.body.reason ?? "").trim() || null;
  const [site, worker] = await Promise.all([
    ProjectSiteModel.findById(siteId).select("name branchId lunchHours").lean(),
    Types.ObjectId.isValid(workerId) ? WorkerModel.findById(workerId).select("empRegNo name designationId designationName").lean() : null,
  ]);
  if (!site || !worker || !inHM || !HM_RE.test(inHM)) {
    flash(req, "danger", "Pick a worker and a valid In time.");
    return res.redirect(`/regularization/${siteId}/${date}`);
  }
  const branch = await BranchModel.findById(site.branchId).select("name").lean();
  const uid = req.currentUser!.id;
  const inTime = istDateTime(date, inHM);
  const outTime = outHM && HM_RE.test(outHM) ? istDateTime(date, outHM) : null;
  const lunch = typeof site.lunchHours === "number" ? site.lunchHours : 1;
  const hours = outTime ? reckonHours(inTime, outTime, lunch) : null;
  const ot = hours?.overtimeHours ?? 0;
  const rec = new AttendanceModel({
    date, workerId: worker._id, empRegNo: worker.empRegNo, workerName: worker.name,
    designationId: worker.designationId, designationName: worker.designationName,
    siteId: site._id, siteName: site.name, branchId: site.branchId, branchName: branch?.name || site.name,
    inTime, outTime, shiftType,
    totalHours: hours?.totalHours ?? null, standardHours: hours?.standardHours ?? null, breakHours: outTime ? lunch : null,
    outSource: outTime ? "hr-filled" : null,
    source: "manual", markedBy: new Types.ObjectId(uid),
    attendanceStatus: "recommended", recommendedBy: new Types.ObjectId(uid), recommendedAt: new Date(),
    overtime: { computedHours: ot, status: ot > 0 ? "pending" : "none" },
    corrections: [{ field: "create", oldValue: null, newValue: "manual day", by: new Types.ObjectId(uid), at: new Date(), reason }],
  });
  try {
    await rec.save();
    flash(req, "success", `Manual day created for ${worker.name}.`);
  } catch {
    flash(req, "danger", "Could not create — a record for that worker/day may already exist.");
  }
  res.redirect(`/regularization/${siteId}/${date}`);
});

export default router;
