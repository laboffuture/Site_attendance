import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { fillOut } from "../lib/attendance";
import { resolveMissedClockout, resolveForgotSubmit } from "../lib/flagResolve";
import { canUseSite, flagScopeFilter } from "../lib/scope";
import { istDateTime } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { FlagEventModel } from "../models/FlagEvent";
import { ProjectSiteModel } from "../models/ProjectSite";

const router = Router();
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

// Flagged events queue (view_flags). Management + HR see every site; PM + Supervisor
// are scoped to their assigned sites by flagScopeFilter.
router.get("/flags", requireCapability("view_flags"), async (req: Request, res: Response) => {
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

router.post("/flags/:id/resolve", requireCapability("view_flags"), async (req: Request, res: Response) => {
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

// Fix a missed clock-out straight from the queue: set the OUT on the linked record,
// push it into the approval chain, and auto-resolve the flag. Any flag-viewer can do
// this (Mgmt/HR see all; PM/Supervisor are limited to their own sites by canUseSite).
router.post("/flags/:id/fix-clockout", requireCapability("view_flags"), async (req: Request, res: Response) => {
  const flag = await FlagEventModel.findById(req.params.id);
  if (!flag || flag.type !== "missed_clockout") {
    flash(req, "danger", "Flag not found.");
    return res.redirect("/flags");
  }
  if (flag.attemptedSiteId && !canUseSite(req.currentUser!, String(flag.attemptedSiteId))) {
    return res.status(403).render("error", { title: "Access denied", active: "", code: 403, message: "Out of your site scope." });
  }
  const outHM = String(req.body.outHM ?? "").trim();
  if (!HM_RE.test(outHM)) {
    flash(req, "danger", "Enter a valid clock-out time (HH:MM).");
    return res.redirect("/flags");
  }
  const rec = flag.attendanceId ? await AttendanceModel.findById(flag.attendanceId) : null;
  if (!rec) {
    flash(req, "danger", "The linked attendance record is no longer there.");
    return res.redirect("/flags");
  }
  if (rec.outTime == null) {
    const site = await ProjectSiteModel.findById(rec.siteId).select("lunchHours").lean();
    const lunch = typeof site?.lunchHours === "number" ? site.lunchHours : 1;
    const role = req.currentUser!.role;
    const outSource = role === "supervisor" || role === "pm" ? "supervisor-filled" : "hr-filled";
    fillOut(rec, istDateTime(rec.date, outHM), lunch, outSource);
    rec.corrections.push({ field: "outTime", oldValue: null, newValue: outHM, by: new Types.ObjectId(req.currentUser!.id), at: new Date(), reason: "Filled forgotten clock-out from the flags queue" });
    rec.source = "manual";
    rec.markedBy = new Types.ObjectId(req.currentUser!.id);
    if (rec.attendanceStatus === "scanned") {
      rec.attendanceStatus = "submitted";
      rec.submittedBy = new Types.ObjectId(req.currentUser!.id);
      rec.submittedAt = new Date();
    }
    await rec.save();
  }
  await resolveMissedClockout(rec._id);
  await resolveForgotSubmit(rec.siteId, rec.date); // if that was the day's last scanned record
  flag.resolved = true;
  await flag.save();
  flash(req, "success", `Clock-out set for ${rec.workerName} — flag resolved.`);
  res.redirect("/flags");
});

// Submit a forgotten site-day straight from the queue, then auto-resolve the flag.
router.post("/flags/:id/submit-day", requireCapability("view_flags"), async (req: Request, res: Response) => {
  const flag = await FlagEventModel.findById(req.params.id);
  if (!flag || flag.type !== "forgot_submit") {
    flash(req, "danger", "Flag not found.");
    return res.redirect("/flags");
  }
  if (flag.attemptedSiteId && !canUseSite(req.currentUser!, String(flag.attemptedSiteId))) {
    return res.status(403).render("error", { title: "Access denied", active: "", code: 403, message: "Out of your site scope." });
  }
  const records = await AttendanceModel.find({ siteId: flag.attemptedSiteId, date: flag.date, attendanceStatus: "scanned" });
  for (const rec of records) {
    rec.attendanceStatus = "submitted";
    rec.submittedBy = new Types.ObjectId(req.currentUser!.id);
    rec.submittedAt = new Date();
    await rec.save();
  }
  if (flag.attemptedSiteId && flag.date) await resolveForgotSubmit(flag.attemptedSiteId, flag.date);
  flag.resolved = true;
  await flag.save();
  flash(req, "success", `Submitted ${records.length} record(s) for ${flag.date} — flag resolved.`);
  res.redirect("/flags");
});

export default router;
