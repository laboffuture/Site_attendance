import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { seesAllSites } from "../auth/permissions";
import type { CurrentUser } from "../auth/types";
import { recordScan } from "../lib/attendance";
import { encodeFace, bestMatch } from "../lib/face";
import { buildGeoCapture, checkGeofence } from "../lib/geo";
import { dataUrlToBuffer } from "../lib/image";
import { canUseSite } from "../lib/scope";
import { siteLocalDate, istHM, round2 } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { FlagEventModel } from "../models/FlagEvent";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

/** Sites the user may log attendance at (top admins: all; others: theirs). */
async function allowedSites(user: CurrentUser) {
  const filter = seesAllSites(user.role)
    ? {}
    : { _id: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
  return ProjectSiteModel.find(filter).sort({ name: 1 }).lean();
}

// ---- Daily grid ----
router.get("/attendance", requireCapability("mark_attendance"), async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const sites = await allowedSites(user);
  if (!sites.length) {
    return res.render("attendance/index", {
      title: "Attendance · " + res.locals.company,
      active: "/attendance",
      sites: [],
      site: null,
      date: siteLocalDate(),
      rows: [],
    });
  }

  const wantedSite = String(req.query.siteId ?? "");
  const site = sites.find((s) => String(s._id) === wantedSite) ?? sites[0];
  const date = DATE_RE.test(String(req.query.date ?? "")) ? String(req.query.date) : siteLocalDate();

  const [workers, records] = await Promise.all([
    // Match by `siteIds` so a worker assigned to this site (primary OR not)
    // shows in its grid.
    WorkerModel.find({ siteIds: site._id, status: "active" }).sort({ name: 1 }).lean(),
    AttendanceModel.find({ siteId: site._id, date }).lean(),
  ]);
  const recByWorker = new Map(records.map((r) => [String(r.workerId), r]));

  const rows = workers.map((w) => {
    const rec = recByWorker.get(String(w._id));
    return {
      workerId: String(w._id),
      empRegNo: w.empRegNo,
      name: w.name,
      designationName: w.designationName,
      inHM: istHM(rec?.inTime ?? null),
      outHM: istHM(rec?.outTime ?? null),
      totalHours: rec?.totalHours ?? null,
      otHours: rec?.overtime?.computedHours ?? 0,
      otStatus: rec?.overtime?.status ?? "none",
      source: rec?.source ?? (rec ? "scan" : null),
    };
  });

  res.render("attendance/index", {
    title: "Attendance · " + res.locals.company,
    active: "/attendance",
    sites,
    site,
    date,
    rows,
  });
});

// Manual mark/correct was removed — attendance is logged ONLY by face scan
// (no type-in entry for any role). The daily grid below is read-only.

// ---- Log Attendance: in-session face-scan for a logged-in Supervisor+ ----
// (Primary attendance method per the rule book; the fixed-station kiosk stays.)
router.get("/attendance/scan", requireCapability("mark_attendance"), async (req: Request, res: Response) => {
  const sites = await allowedSites(req.currentUser!);
  const today = siteLocalDate();
  // Today's logged scans across the user's sites — shown so the page reflects
  // activity, not a blank screen. Newest first.
  const siteIds = sites.map((s) => s._id);
  const records = siteIds.length
    ? await AttendanceModel.find({ siteId: { $in: siteIds }, date: today })
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean()
    : [];
  const logged = records.map((r) => ({
    workerName: r.workerName,
    empRegNo: r.empRegNo,
    siteName: r.siteName,
    inHM: istHM(r.inTime ?? null),
    outHM: istHM(r.outTime ?? null),
    state: r.outTime ? "OUT" : "IN",
  }));
  res.render("attendance/scan", {
    title: "Log Attendance · " + res.locals.company,
    active: "/attendance",
    sites,
    logged,
    today,
  });
});

// Up-front location check for a picked site (geofence-first): the page calls
// this on site-select and only unlocks Scan when the device is confirmed inside.
router.post("/attendance/geocheck", requireCapability("mark_attendance"), async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const siteId = String(req.body.siteId ?? "");
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(user, siteId)) {
    return res.json({ status: "error", message: "Select a site you're assigned to." });
  }
  const site = await ProjectSiteModel.findById(siteId).lean();
  if (!site) return res.json({ status: "error", message: "Site not found." });

  const geo = buildGeoCapture(req.body.lat, req.body.lng, req.body.accuracy, site);
  const fence = checkGeofence(site, geo);
  res.json({
    status: fence, // off | inside | outside | no_fix
    siteName: site.name,
    distanceMeters: geo.distanceMeters,
    radius: site.geofenceRadiusMeters ?? null,
  });
});

router.post("/attendance/scan", requireCapability("mark_attendance"), async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const siteId = String(req.body.siteId ?? "");
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(user, siteId)) {
    return res.json({ status: "error", message: "Select a site you're assigned to." });
  }
  const site = await ProjectSiteModel.findById(siteId).lean();
  if (!site) return res.json({ status: "error", message: "Site not found." });

  const photo = dataUrlToBuffer(String(req.body.photoData ?? ""));
  if (!photo) return res.json({ status: "error", message: "No image received." });

  // Geofence gate first — cheap reject before face matching. Enforced only when
  // the picked site has coordinates + a radius; otherwise GPS is capture-only.
  const geo = buildGeoCapture(req.body.lat, req.body.lng, req.body.accuracy, site);
  const fence = checkGeofence(site, geo);
  if (fence === "outside") {
    return res.json({ status: "out_of_range", siteName: site.name, distanceMeters: geo.distanceMeters, radius: site.geofenceRadiusMeters });
  }
  if (fence === "no_fix") {
    return res.json({ status: "location_required", siteName: site.name });
  }

  let probe: number[] | null;
  try {
    probe = await encodeFace(photo);
  } catch {
    return res.json({ status: "error", message: "Could not read the image." });
  }
  if (!probe) return res.json({ status: "no_face" });

  const workers = await WorkerModel.find({ status: "active", "faceEncoding.0": { $exists: true } })
    .select("name empRegNo siteId siteIds siteName designationId designationName faceEncoding")
    .lean();
  const match = bestMatch(probe, workers.map((w) => ({ id: String(w._id), descriptor: w.faceEncoding })));
  if (!match) return res.json({ status: "unknown" });
  const worker = workers.find((w) => String(w._id) === match.id)!;

  // Location-lock to the PICKED site (mirrors the kiosk, scoped to this user).
  // A worker may clock in at ANY of their assigned sites; only a site they're
  // not assigned to is a wrong-site scan.
  if (!worker.siteIds.map(String).includes(siteId)) {
    await FlagEventModel.create({
      type: "wrong_site_scan",
      workerId: worker._id,
      workerName: worker.name,
      attemptedSiteId: site._id,
      attemptedSiteName: site.name,
      homeSiteId: worker.siteId,
      homeSiteName: worker.siteName,
    });
    return res.json({ status: "wrong_site", workerName: worker.name, empRegNo: worker.empRegNo, homeSite: worker.siteName, thisSite: site.name });
  }

  const branch = await BranchModel.findById(site.branchId).lean();
  const result = await recordScan(
    { _id: worker._id, empRegNo: worker.empRegNo, name: worker.name, designationId: worker.designationId, designationName: worker.designationName },
    site,
    branch?.name ?? "",
    geo,
  );

  res.json({
    status: result.action, // "in" | "out"
    workerName: worker.name,
    empRegNo: worker.empRegNo,
    time: istHM(result.action === "in" ? result.inTime : result.outTime),
    totalHours: result.totalHours,
    overtimeHours: round2(result.overtimeHours),
    overtimeStatus: result.overtimeStatus,
    geo: { available: geo.available, distanceMeters: geo.distanceMeters },
  });
});

// ---- Supervisor: submit the day for regularization ----
router.get("/attendance/submit", requireCapability("submit_attendance"), async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const sites = await allowedSites(user);
  const site = sites.find((s) => String(s._id) === String(req.query.siteId)) ?? sites[0] ?? null;
  const date = DATE_RE.test(String(req.query.date ?? "")) ? String(req.query.date) : siteLocalDate();
  const records = site ? await AttendanceModel.find({ siteId: site._id, date }).sort({ workerName: 1 }).lean() : [];
  const rows = records.map((r) => ({
    id: String(r._id), workerId: String(r.workerId), workerName: r.workerName, empRegNo: r.empRegNo,
    inHM: istHM(r.inTime ?? null), outHM: istHM(r.outTime ?? null),
    totalHours: r.totalHours, otHours: r.overtime?.computedHours ?? 0,
    status: r.attendanceStatus, remark: r.dailyRemark ?? "",
    open: !r.outTime,
  }));
  const submitted = records.length > 0 && records.every((r) => r.attendanceStatus !== "scanned");
  res.render("attendance/submit", { title: "Submit attendance · " + res.locals.company, active: "/attendance", sites, site, date, rows, submitted });
});

router.post("/attendance/submit", requireCapability("submit_attendance"), async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const siteId = String(req.body.siteId ?? "");
  const date = String(req.body.date ?? "");
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(user, siteId) || !DATE_RE.test(date)) {
    flash(req, "danger", "Pick a site you're assigned to and a valid date.");
    return res.redirect("/attendance/submit");
  }
  const records = await AttendanceModel.find({ siteId, date, attendanceStatus: "scanned" });
  for (const rec of records) {
    rec.attendanceStatus = "submitted";
    rec.dailyRemark = String(req.body[`remark_${rec.workerId}`] ?? "").trim() || null;
    rec.submittedBy = new Types.ObjectId(user.id);
    rec.submittedAt = new Date();
    await rec.save();
  }
  flash(req, "success", `Submitted ${records.length} record(s) for ${date}.`);
  res.redirect(`/attendance/submit?siteId=${siteId}&date=${date}`);
});

export default router;
