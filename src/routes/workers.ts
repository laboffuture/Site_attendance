import fs from "fs/promises";
import path from "path";

import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { can, seesAllSites } from "../auth/permissions";
import type { CurrentUser } from "../auth/types";
import { config } from "../config";
import { encodeFace } from "../lib/face";
import { dataUrlToBuffer } from "../lib/image";
import { siteScopeFilter, canUseSite } from "../lib/scope";
import { escapeRegex, isDuplicateKeyError } from "../lib/validate";
import { DesignationModel } from "../models/Designation";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel, RemarkType } from "../models/Worker";

const router = Router();
const UPLOAD_DIR = config.uploadDir;

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

/** Append an audit remark to a hydrated worker doc (caller saves).
 *  Only `text` is required on the subdoc; `cleared`/`clearedBy`/`clearedAt`
 *  fall back to their schema defaults, so they're omitted here. */
function pushRemark(
  worker: InstanceType<typeof WorkerModel>,
  user: CurrentUser,
  text: string,
  type: RemarkType,
): void {
  worker.remarks.push({
    text,
    type,
    authorId: new Types.ObjectId(user.id),
    authorName: user.name,
    at: new Date(),
  } as never);
}

/** Sites a user may enroll workers into (Management/HR: all; others: theirs). */
async function allowedSites(user: CurrentUser) {
  const filter = seesAllSites(user.role)
    ? {}
    : { _id: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
  return ProjectSiteModel.find(filter).sort({ name: 1 }).lean();
}

/** Reads the optional contact + bank + joining fields from the form.
 *  Empty strings become null; bank is null unless at least one field is given. */
function parseEmployeeExtras(req: Request) {
  const s = (k: string): string | null => {
    const v = String(req.body[k] ?? "").trim();
    return v || null;
  };
  const bank = {
    accountHolderName: s("bankAccountHolder"),
    accountNumber: s("bankAccountNumber"),
    ifsc: s("bankIfsc") ? s("bankIfsc")!.toUpperCase() : null,
    bankName: s("bankName"),
  };
  const hasBank = Object.values(bank).some(Boolean);
  const djRaw = String(req.body.dateJoined ?? "").trim();
  const dateJoined = /^\d{4}-\d{2}-\d{2}$/.test(djRaw)
    ? new Date(`${djRaw}T00:00:00+05:30`)
    : undefined;
  return { phone: s("phone"), emergencyPhone: s("emergencyPhone"), email: s("email"), bank: hasBank ? bank : null, dateJoined };
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

const STATUS_TABS: Record<string, string[]> = {
  active: ["active", "inactive"],
  pending: ["pending"],
  archived: ["deleted"],
};

// ---- List (status-tabbed) ----
router.get("/workers", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const tab = STATUS_TABS[String(req.query.status)] ? String(req.query.status) : "active";
  const scope = siteScopeFilter(req.currentUser!);
  const [workers, active, pending, archived] = await Promise.all([
    WorkerModel.find({ ...scope, status: { $in: STATUS_TABS[tab] } }).sort({ createdAt: -1 }).lean(),
    WorkerModel.countDocuments({ ...scope, status: { $in: ["active", "inactive"] } }),
    WorkerModel.countDocuments({ ...scope, status: "pending" }),
    WorkerModel.countDocuments({ ...scope, status: "deleted" }),
  ]);
  res.render("workers/index", {
    title: "Employees · " + res.locals.company,
    active: "/workers",
    workers,
    tab,
    counts: { active, pending, archived },
  });
});

// ---- Enrollment form ----
router.get("/workers/new", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const [designations, sites] = await Promise.all([
    DesignationModel.find().sort({ name: 1 }).lean(),
    allowedSites(req.currentUser!),
  ]);
  res.render("workers/new", {
    title: "Enroll employee · " + res.locals.company,
    active: "/workers",
    designations,
    sites,
  });
});

// ---- Create ----
router.post("/workers", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  const empRegNo = String(req.body.empRegNo ?? "").trim();
  const siteId = String(req.body.siteId ?? "").trim();
  const photo = dataUrlToBuffer(String(req.body.photoData ?? ""));

  if (!name || !empRegNo || !siteId) {
    flash(req, "danger", "Employee ID, name, and site are required.");
    return res.redirect("/workers/new");
  }
  if (await WorkerModel.findOne({ empRegNo })) {
    flash(req, "danger", `Employee ID "${empRegNo}" already exists.`);
    return res.redirect("/workers/new");
  }
  if (!canUseSite(req.currentUser!, siteId)) {
    flash(req, "danger", "You cannot enroll employees at that site.");
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

  const extras = parseEmployeeExtras(req);
  let worker;
  try {
    worker = await WorkerModel.create({
      empRegNo,
      name,
      designationId: designation.id,
      designationName: designation.name,
      siteId: site._id,
      siteName: site.name,
      phone: extras.phone,
      emergencyPhone: extras.emergencyPhone,
      email: extras.email,
      bank: extras.bank,
      ...(extras.dateJoined ? { dateJoined: extras.dateJoined } : {}),
      faceEncoding: encoding,
      status: "active",
    });
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Employee ID "${empRegNo}" already exists.` : "Could not create employee.");
    return res.redirect("/workers/new");
  }

  // Store the photo by _id (manual Employee IDs may contain unsafe filename chars).
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, `${worker._id}.jpg`), photo);
  worker.photoUrl = `/static/uploads/${worker._id}.jpg`;
  await worker.save();

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
    title: "Edit employee · " + res.locals.company,
    active: "/workers",
    worker,
    designations,
    sites,
    canDelete: can(req.currentUser!.role, "delete_worker"),
  });
});

router.post("/workers/:id", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Worker not found.");
    return res.redirect("/workers");
  }
  if (worker.status === "deleted") {
    flash(req, "danger", "Restore this employee before editing.");
    return res.redirect("/workers?status=archived");
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

  const extras = parseEmployeeExtras(req);
  worker.name = name;
  worker.designationId = designation.id;
  worker.designationName = designation.name;
  worker.siteId = site._id;
  worker.siteName = site.name;
  worker.status = status;
  worker.phone = extras.phone;
  worker.emergencyPhone = extras.emergencyPhone;
  worker.email = extras.email;
  worker.bank = extras.bank;
  if (extras.dateJoined) worker.dateJoined = extras.dateJoined;
  await worker.save();

  flash(req, "success", "Employee updated.");
  res.redirect("/workers");
});

// ---- Soft-delete (admin) — mandatory reason, retained + hidden ----
router.post("/workers/:id/delete", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const reason = String(req.body.reason ?? "").trim();
  if (!reason) {
    flash(req, "danger", "A reason is required to delete an employee.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  if (worker.status === "deleted") {
    flash(req, "danger", "Employee is already deleted.");
    return res.redirect("/workers");
  }
  worker.status = "deleted";
  worker.deletedAt = new Date();
  worker.deletedBy = new Types.ObjectId(req.currentUser!.id);
  pushRemark(worker, req.currentUser!, reason, "soft_delete");
  await worker.save();
  flash(req, "success", `Employee ${worker.name} deleted.`);
  res.redirect("/workers");
});

// ---- Restore (admin) — deleted → active ----
router.post("/workers/:id/restore", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  if (worker.status !== "deleted") {
    flash(req, "danger", "Only a deleted employee can be restored.");
    return res.redirect("/workers");
  }
  worker.status = "active";
  worker.deletedAt = null;
  worker.deletedBy = null;
  pushRemark(worker, req.currentUser!, "Employee restored.", "note");
  await worker.save();
  flash(req, "success", `Employee ${worker.name} restored.`);
  res.redirect("/workers?status=archived");
});

// ---- Remarks: add a note (scoped editors) ----
router.post("/workers/:id/remarks", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const text = String(req.body.text ?? "").trim();
  if (!text) {
    flash(req, "danger", "Remark text is required.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  pushRemark(worker, req.currentUser!, text, "note");
  await worker.save();
  flash(req, "success", "Remark added.");
  res.redirect(`/workers/${req.params.id}/edit`);
});

// ---- Remarks: clear one (admin) — struck through, kept for audit ----
router.post("/workers/:id/remarks/:idx/clear", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= worker.remarks.length) {
    flash(req, "danger", "Remark not found.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  const r = worker.remarks[idx];
  if (!r.cleared) {
    r.cleared = true;
    r.clearedBy = new Types.ObjectId(req.currentUser!.id);
    r.clearedAt = new Date();
    await worker.save();
  }
  flash(req, "success", "Remark cleared.");
  res.redirect(`/workers/${req.params.id}/edit`);
});

export default router;
