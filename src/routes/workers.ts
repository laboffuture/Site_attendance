import fs from "fs/promises";
import path from "path";

import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import type { CurrentUser } from "../auth/types";
import { config } from "../config";
import { encodeFace } from "../lib/face";
import { dataUrlToBuffer } from "../lib/image";
import { siteScopeFilter, canUseSite } from "../lib/scope";
import { escapeRegex } from "../lib/validate";
import { CounterModel } from "../models/Counter";
import { DesignationModel } from "../models/Designation";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const UPLOAD_DIR = config.uploadDir;

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

/** Sites a user may enroll workers into (Management/HR: all; others: theirs). */
async function allowedSites(user: CurrentUser) {
  const filter =
    user.role === "management" || user.role === "hr"
      ? {}
      : { _id: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
  return ProjectSiteModel.find(filter).sort({ name: 1 }).lean();
}

/** Atomically mints the next employee registration number, e.g. TRGBI-0001. */
async function nextEmpRegNo(): Promise<string> {
  const c = await CounterModel.findOneAndUpdate(
    { key: "empRegNo" },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  const prefix = (config.companyName || "EMP").replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "EMP";
  return `${prefix}-${String(c!.seq).padStart(4, "0")}`;
}

/** Resolves a designation from the form: an existing id, or a new name typed
 *  "on the spot" (find-or-create, case-insensitive). */
async function resolveDesignation(
  designationId: string,
  newName: string,
): Promise<{ id: Types.ObjectId; name: string } | null> {
  const typed = newName.trim();
  if (typed) {
    const existing = await DesignationModel.findOne({
      name: new RegExp(`^${escapeRegex(typed)}$`, "i"),
    });
    if (existing) return { id: existing._id, name: existing.name };
    const created = await DesignationModel.create({ name: typed });
    return { id: created._id, name: created.name };
  }
  if (designationId) {
    const d = await DesignationModel.findById(designationId);
    if (d) return { id: d._id, name: d.name };
  }
  return null;
}

// ---- List ----
router.get("/workers", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const workers = await WorkerModel.find(siteScopeFilter(req.currentUser!))
    .sort({ createdAt: -1 })
    .lean();
  res.render("workers/index", {
    title: "Workers · " + res.locals.company,
    active: "/workers",
    workers,
  });
});

// ---- Enrollment form ----
router.get("/workers/new", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const [designations, sites] = await Promise.all([
    DesignationModel.find().sort({ name: 1 }).lean(),
    allowedSites(req.currentUser!),
  ]);
  res.render("workers/new", {
    title: "Enroll worker · " + res.locals.company,
    active: "/workers",
    designations,
    sites,
  });
});

// ---- Create ----
router.post("/workers", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  const siteId = String(req.body.siteId ?? "").trim();
  const photo = dataUrlToBuffer(String(req.body.photoData ?? ""));

  if (!name || !siteId) {
    flash(req, "danger", "Name and site are required.");
    return res.redirect("/workers/new");
  }
  if (!canUseSite(req.currentUser!, siteId)) {
    flash(req, "danger", "You cannot enroll workers at that site.");
    return res.redirect("/workers/new");
  }
  const site = await ProjectSiteModel.findById(siteId).lean();
  if (!site) {
    flash(req, "danger", "Selected site does not exist.");
    return res.redirect("/workers/new");
  }
  const designation = await resolveDesignation(
    String(req.body.designationId ?? ""),
    String(req.body.newDesignation ?? ""),
  );
  if (!designation) {
    flash(req, "danger", "Pick a designation or enter a new one.");
    return res.redirect("/workers/new");
  }
  if (!photo) {
    flash(req, "danger", "Capture or upload a photo before enrolling.");
    return res.redirect("/workers/new");
  }

  let encoding: number[] | null;
  try {
    encoding = await encodeFace(photo);
  } catch {
    flash(req, "danger", "Could not read the photo. Use a clear JPEG and retake.");
    return res.redirect("/workers/new");
  }
  if (!encoding) {
    flash(req, "danger", "No single clear face detected — center one face and retake.");
    return res.redirect("/workers/new");
  }

  const empRegNo = await nextEmpRegNo();
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, `${empRegNo}.jpg`), photo);

  await WorkerModel.create({
    empRegNo,
    name,
    designationId: designation.id,
    designationName: designation.name,
    siteId: site._id,
    siteName: site.name,
    faceEncoding: encoding,
    photoUrl: `/static/uploads/${empRegNo}.jpg`,
    status: "active",
  });

  flash(req, "success", `Enrolled ${name} (${empRegNo}).`);
  res.redirect("/workers");
});

// ---- Edit ----
router.get("/workers/:id/edit", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id).lean();
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Worker not found.");
    return res.redirect("/workers");
  }
  const [designations, sites] = await Promise.all([
    DesignationModel.find().sort({ name: 1 }).lean(),
    allowedSites(req.currentUser!),
  ]);
  res.render("workers/edit", {
    title: "Edit worker · " + res.locals.company,
    active: "/workers",
    worker,
    designations,
    sites,
  });
});

router.post("/workers/:id", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Worker not found.");
    return res.redirect("/workers");
  }
  const name = String(req.body.name ?? "").trim();
  const siteId = String(req.body.siteId ?? "").trim();
  const status = req.body.status === "inactive" ? "inactive" : "active";
  if (!name || !siteId) {
    flash(req, "danger", "Name and site are required.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  if (!canUseSite(req.currentUser!, siteId)) {
    flash(req, "danger", "You cannot move a worker to that site.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  const site = await ProjectSiteModel.findById(siteId).lean();
  if (!site) {
    flash(req, "danger", "Selected site does not exist.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  const designation = await resolveDesignation(
    String(req.body.designationId ?? ""),
    String(req.body.newDesignation ?? ""),
  );
  if (!designation) {
    flash(req, "danger", "Pick a designation or enter a new one.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }

  worker.name = name;
  worker.designationId = designation.id;
  worker.designationName = designation.name;
  worker.siteId = site._id;
  worker.siteName = site.name;
  worker.status = status;
  await worker.save();

  flash(req, "success", "Worker updated.");
  res.redirect("/workers");
});

export default router;
