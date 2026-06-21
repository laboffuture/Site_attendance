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
import { canUseSite, canUseWorker, workerScopeFilter } from "../lib/scope";
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

/** Parses the multi-valued `siteIds` form field (array-or-single, like
 *  users.ts) into a de-duplicated list of valid ObjectId strings, order kept
 *  (the first is the primary). Falls back to a legacy single `siteId` field so
 *  older callers/forms keep working. */
function parseSiteIds(body: Record<string, unknown>): string[] {
  const raw = body.siteIds ?? body.siteId;
  const arr = Array.isArray(raw) ? raw : raw != null && raw !== "" ? [raw] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr.map(String)) {
    if (Types.ObjectId.isValid(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Sites a user may enroll workers into (Management/HR: all; others: theirs). */
async function allowedSites(user: CurrentUser) {
  const filter = seesAllSites(user.role)
    ? {}
    : { _id: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
  return ProjectSiteModel.find(filter).sort({ name: 1 }).lean();
}

/** Reads the optional contact + pay + bank + joining fields from the form.
 *  Empty strings become null; bank is null unless at least one field is given. */
function parseEmployeeExtras(req: Request) {
  const s = (k: string): string | null => {
    const v = String(req.body[k] ?? "").trim();
    return v || null;
  };
  const num = (k: string): number | null => {
    const v = String(req.body[k] ?? "").trim();
    const n = parseFloat(v);
    return v !== "" && Number.isFinite(n) && n >= 0 ? n : null;
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
  const foodApplicable = req.body.foodAllowanceApplicable === "on" || req.body.foodAllowanceApplicable === "true";
  const foodAmount = num("foodAllowanceAmount");
  return {
    phone: s("phone"),
    emergencyPhone: s("emergencyPhone"),
    email: s("email"),
    dailyWage: num("dailyWage"),
    foodAllowance: { applicable: foodApplicable, amount: foodApplicable ? foodAmount : null },
    bank: hasBank ? bank : null,
    dateJoined,
  };
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
  const faceFilter = String(req.query.face) === "unregistered" ? "unregistered" : "all";
  // Workers can be assigned to many sites, so scope by `siteIds` overlap.
  const scope = workerScopeFilter(req.currentUser!);
  const listQuery: Record<string, unknown> = { ...scope, status: { $in: STATUS_TABS[tab] } };
  // "faceEncoding.0" exists ⇒ at least one descriptor ⇒ enrolled.
  if (faceFilter === "unregistered") listQuery["faceEncoding.0"] = { $exists: false };
  const [workers, active, pending, archived, faceRegistered] = await Promise.all([
    WorkerModel.find(listQuery).sort({ createdAt: -1 }).lean(),
    WorkerModel.countDocuments({ ...scope, status: { $in: ["active", "inactive"] } }),
    WorkerModel.countDocuments({ ...scope, status: "pending" }),
    WorkerModel.countDocuments({ ...scope, status: "deleted" }),
    WorkerModel.countDocuments({ ...scope, status: { $in: ["active", "inactive"] }, "faceEncoding.0": { $exists: true } }),
  ]);
  // Compute the enrolled flag and drop the bulky descriptor from the payload.
  const rows = workers.map((w) => {
    const hasFace = Array.isArray(w.faceEncoding) && w.faceEncoding.length > 0;
    const { faceEncoding, ...rest } = w;
    void faceEncoding;
    return { ...rest, hasFace };
  });
  res.render("workers/index", {
    title: "Employees · " + res.locals.company,
    active: "/workers",
    workers: rows,
    tab,
    faceFilter,
    counts: { active, pending, archived },
    face: { registered: faceRegistered, total: active },
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
  const siteIds = parseSiteIds(req.body);
  const photo = dataUrlToBuffer(String(req.body.photoData ?? ""));

  if (!name || !empRegNo || !siteIds.length) {
    flash(req, "danger", "Employee ID, name, and at least one site are required.");
    return res.redirect("/workers/new");
  }
  if (await WorkerModel.findOne({ empRegNo })) {
    flash(req, "danger", `Employee ID "${empRegNo}" already exists.`);
    return res.redirect("/workers/new");
  }
  if (!siteIds.every((id) => canUseSite(req.currentUser!, id))) {
    flash(req, "danger", "You cannot enroll employees at one of the chosen sites.");
    return res.redirect("/workers/new");
  }
  // Resolve every chosen site; primary = the first picked (siteIds order).
  const sites = await ProjectSiteModel.find({ _id: { $in: siteIds } }).lean();
  const siteById = new Map(sites.map((s) => [String(s._id), s]));
  const orderedSites = siteIds.map((id) => siteById.get(id)).filter(Boolean) as typeof sites;
  const site = orderedSites[0];
  if (!site || orderedSites.length !== siteIds.length) {
    flash(req, "danger", "One of the selected sites does not exist.");
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
      siteIds: orderedSites.map((s) => s._id),
      siteId: site._id, // primary (the hook also keeps this = siteIds[0])
      siteName: site.name,
      phone: extras.phone,
      emergencyPhone: extras.emergencyPhone,
      email: extras.email,
      dailyWage: extras.dailyWage,
      foodAllowance: extras.foodAllowance,
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
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
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
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
    flash(req, "danger", "Worker not found.");
    return res.redirect("/workers");
  }
  if (worker.status === "deleted") {
    flash(req, "danger", "Restore this employee before editing.");
    return res.redirect("/workers?status=archived");
  }
  const name = String(req.body.name ?? "").trim();
  const submitted = parseSiteIds(req.body);
  const status = req.body.status === "inactive" ? "inactive" : "active";
  if (!name || !submitted.length) {
    flash(req, "danger", "Name and at least one site are required.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  // The editor can only assign sites in their own scope; any site already on the
  // worker that's OUTSIDE the editor's scope is preserved (we never silently
  // drop an assignment the editor can't even see). Result order: submitted
  // (in-scope) first, then the retained out-of-scope ones → primary stays the
  // editor's chosen first pick.
  if (!submitted.every((id) => canUseSite(req.currentUser!, id))) {
    flash(req, "danger", "You cannot assign a worker to that site.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  const retained = worker.siteIds
    .map(String)
    .filter((id) => !canUseSite(req.currentUser!, id) && !submitted.includes(id));
  const finalIds = [...submitted, ...retained];
  const sites = await ProjectSiteModel.find({ _id: { $in: finalIds } }).lean();
  const siteById = new Map(sites.map((s) => [String(s._id), s]));
  const orderedSites = finalIds.map((id) => siteById.get(id)).filter(Boolean) as typeof sites;
  const site = orderedSites[0];
  if (!site || orderedSites.length !== finalIds.length) {
    flash(req, "danger", "One of the selected sites does not exist.");
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
  worker.siteIds = orderedSites.map((s) => s._id) as never;
  worker.siteId = site._id; // primary (the hook also keeps this = siteIds[0])
  worker.siteName = site.name;
  worker.status = status;
  worker.phone = extras.phone;
  worker.emergencyPhone = extras.emergencyPhone;
  worker.email = extras.email;
  worker.dailyWage = extras.dailyWage;
  worker.foodAllowance = extras.foodAllowance;
  worker.bank = extras.bank;
  if (extras.dateJoined) worker.dateJoined = extras.dateJoined;
  await worker.save();

  flash(req, "success", "Employee updated.");
  res.redirect("/workers");
});

// ---- Soft-delete (admin) — mandatory reason, retained + hidden ----
router.post("/workers/:id/delete", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
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
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
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
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
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
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
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

// ---- Enrol / replace a face on an existing worker (imports have none) ----
// Dedicated "Register face" capture page — the onboarding sweep entry point.
// Focused on one worker; on save it returns to the unregistered worklist.
router.get("/workers/:id/face", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id).lean();
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
    flash(req, "danger", "Employee not found or out of your site scope.");
    return res.redirect("/workers");
  }
  res.render("workers/face", {
    title: "Register face · " + res.locals.company,
    active: "/workers",
    worker,
    hasFace: Array.isArray(worker.faceEncoding) && worker.faceEncoding.length > 0,
  });
});

router.post("/workers/:id/face", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  // Where to land after this request: the sweep page (when launched from the
  // roster) vs the worker's Edit form.
  const fromRoster = String(req.body.returnTo ?? "") === "roster";
  const backOnError = fromRoster ? `/workers/${req.params.id}/face` : `/workers/${req.params.id}/edit`;
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const photo = dataUrlToBuffer(String(req.body.photoData ?? ""));
  if (!photo) {
    flash(req, "danger", "Capture or upload a photo first.");
    return res.redirect(backOnError);
  }
  let encoding: number[] | null;
  try {
    encoding = await encodeFace(photo);
  } catch {
    flash(req, "danger", "Could not read the photo. Use a clear JPEG and retake.");
    return res.redirect(backOnError);
  }
  if (!encoding) {
    flash(req, "danger", "No single clear face detected — center one face and retake.");
    return res.redirect(backOnError);
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, `${worker._id}.jpg`), photo);
  worker.faceEncoding = encoding;
  worker.photoUrl = `/static/uploads/${worker._id}.jpg`;
  pushRemark(worker, req.currentUser!, "Face enrolled.", "note");
  await worker.save();
  flash(req, "success", `Face enrolled for ${worker.name}.`);
  res.redirect(fromRoster ? "/workers?face=unregistered" : `/workers/${req.params.id}/edit`);
});

export default router;
