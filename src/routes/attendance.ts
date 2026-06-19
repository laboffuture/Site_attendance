import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { seesAllSites } from "../auth/permissions";
import type { CurrentUser } from "../auth/types";
import { canUseSite } from "../lib/scope";
import {
  siteLocalDate,
  istDateTime,
  istHM,
  standardHoursForSite,
  round2,
} from "../lib/time";
import { isValidTime, endAfterStart } from "../lib/validate";
import { AttendanceModel } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

/** Sites the user may mark attendance at (top admins: all; others: theirs). */
async function allowedSites(user: CurrentUser) {
  const filter = seesAllSites(user.role)
    ? {}
    : { _id: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
  return ProjectSiteModel.find(filter).sort({ name: 1 }).lean();
}

function backTo(siteId: string, date: string): string {
  return `/attendance?siteId=${siteId}&date=${date}`;
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
    WorkerModel.find({ siteId: site._id, status: "active" }).sort({ name: 1 }).lean(),
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

// ---- Manual mark / correct ----
router.post("/attendance/mark", requireCapability("mark_attendance"), async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const workerId = String(req.body.workerId ?? "");
  const date = String(req.body.date ?? "");
  const inTime = String(req.body.inTime ?? "").trim();
  const outTime = String(req.body.outTime ?? "").trim();

  if (!Types.ObjectId.isValid(workerId) || !DATE_RE.test(date)) {
    flash(req, "danger", "Invalid request.");
    return res.redirect("/attendance");
  }
  const worker = await WorkerModel.findById(workerId).lean();
  if (!worker || !canUseSite(user, String(worker.siteId))) {
    flash(req, "danger", "Worker not found or outside your sites.");
    return res.redirect("/attendance");
  }
  const site = await ProjectSiteModel.findById(worker.siteId).lean();
  if (!site) {
    flash(req, "danger", "Site not found.");
    return res.redirect("/attendance");
  }
  const back = backTo(String(site._id), date);

  // In is required to have a record; Out is optional. (Day shifts only — an
  // Out earlier than In is rejected rather than assumed to cross midnight.)
  if (!isValidTime(inTime)) {
    flash(req, "danger", "Enter a valid In time (HH:MM).");
    return res.redirect(back);
  }
  if (outTime && !isValidTime(outTime)) {
    flash(req, "danger", "Out time must be HH:MM.");
    return res.redirect(back);
  }
  if (outTime && !endAfterStart(inTime, outTime)) {
    flash(req, "danger", "Out time must be after In time.");
    return res.redirect(back);
  }

  const inDate = istDateTime(date, inTime);
  const outDate = outTime ? istDateTime(date, outTime) : null;

  let totalHours: number | null = null;
  let standardHours: number | null = null;
  let overtime: Record<string, unknown> = {
    computedHours: 0,
    status: "none",
    approvedHours: null,
    approvedBy: null,
    approvedAt: null,
    notes: null,
  };
  if (outDate) {
    totalHours = round2((outDate.getTime() - inDate.getTime()) / 3_600_000);
    standardHours = round2(standardHoursForSite(site, String(worker.designationId)));
    const ot = round2(Math.max(0, totalHours - standardHours));
    overtime = { computedHours: ot, status: ot > 0 ? "pending" : "none", approvedHours: null, approvedBy: null, approvedAt: null, notes: null };
  }

  const branch = await BranchModel.findById(site.branchId).lean();

  await AttendanceModel.findOneAndUpdate(
    { workerId: worker._id, date },
    {
      $set: {
        inTime: inDate,
        outTime: outDate,
        totalHours,
        standardHours,
        overtime,
        source: "manual",
        markedBy: new Types.ObjectId(user.id),
      },
      $setOnInsert: {
        workerId: worker._id,
        date,
        empRegNo: worker.empRegNo,
        workerName: worker.name,
        designationId: worker.designationId,
        designationName: worker.designationName,
        siteId: site._id,
        siteName: site.name,
        branchId: site.branchId,
        branchName: branch?.name ?? "",
      },
    },
    { upsert: true },
  );

  flash(req, "success", `Attendance saved for ${worker.name}.`);
  res.redirect(back);
});

export default router;
