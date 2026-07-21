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
import { pushRemark } from "../lib/remarks";
import { canUseSite, canUseWorker, workerScopeFilter } from "../lib/scope";
import { escapeRegex, isDuplicateKeyError } from "../lib/validate";
import { AttendanceModel } from "../models/Attendance";
import { DeletionLogModel } from "../models/DeletionLog";
import { DesignationModel } from "../models/Designation";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const UPLOAD_DIR = config.uploadDir;

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
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

/** Sites a user may enroll workers into (Management/HR: all; others: theirs).
 *  Archived / deleted sites are never enrollment targets. */
async function allowedSites(user: CurrentUser) {
  const filter: Record<string, unknown> = seesAllSites(user.role)
    ? {}
    : { _id: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
  filter.status = "active";
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

// "deleted" appears in no tab — hidden-deleted workers are only visible in the
// Deletion log.
const STATUS_TABS: Record<string, string[]> = {
  active: ["active", "inactive"],
  pending: ["pending"],
  archived: ["archived"],
};

// ---- List (status-tabbed) ----
router.get("/workers", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const tab = STATUS_TABS[String(req.query.status)] ? String(req.query.status) : "active";
  const faceFilter = String(req.query.face) === "unregistered" ? "unregistered" : "all";
  const q = String(req.query.q ?? "").trim();
  // Workers can be assigned to many sites, so scope by `siteIds` overlap.
  const scope = workerScopeFilter(req.currentUser!);
  const sites = await allowedSites(req.currentUser!);
  // Optional single-site filter (only a site the user actually has).
  const reqSiteId = String(req.query.siteId ?? "");
  const selectedSiteId = reqSiteId && sites.some((s) => String(s._id) === reqSiteId) ? reqSiteId : "";

  const listQuery: Record<string, unknown> = { ...scope, status: { $in: STATUS_TABS[tab] } };
  // "faceEncoding.0" exists ⇒ at least one descriptor ⇒ enrolled.
  if (faceFilter === "unregistered") listQuery["faceEncoding.0"] = { $exists: false };
  if (selectedSiteId) listQuery.siteIds = new Types.ObjectId(selectedSiteId);
  // Free-text search across name + Employee ID (case-insensitive).
  if (q) listQuery.$or = [{ name: new RegExp(escapeRegex(q), "i") }, { empRegNo: new RegExp(escapeRegex(q), "i") }];

  const [workers, activeTab, activeOnly, pending, archived, faceRegistered] = await Promise.all([
    WorkerModel.find(listQuery).sort({ createdAt: -1 }).lean(),
    WorkerModel.countDocuments({ ...scope, status: { $in: ["active", "inactive"] } }),
    WorkerModel.countDocuments({ ...scope, status: "active" }),
    WorkerModel.countDocuments({ ...scope, status: "pending" }),
    WorkerModel.countDocuments({ ...scope, status: "archived" }),
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
    q,
    sites,
    selectedSiteId,
    counts: { active: activeTab, pending, archived },
    summary: {
      total: activeTab + pending,
      active: activeOnly,
      pending,
      faceRegistered,
      faceTotal: activeTab,
      facePending: activeTab - faceRegistered,
    },
    face: { registered: faceRegistered, total: activeTab },
  });
});

// ---- Bulk actions ----
// One action applied to many selected employees at once. Every worker is
// individually re-checked against the actor's scope/permissions — exactly the
// rules that govern the single-employee routes — and out-of-scope or
// wrong-state selections are skipped (and counted in the flash), never errors.

/** Parses the comma-separated `ids` field into valid, de-duplicated ObjectIds. */
function parseBulkIds(raw: unknown): Types.ObjectId[] {
  const seen = new Set<string>();
  const out: Types.ObjectId[] = [];
  for (const v of String(raw ?? "").split(",")) {
    const id = v.trim();
    if (Types.ObjectId.isValid(id) && !seen.has(id)) {
      seen.add(id);
      out.push(new Types.ObjectId(id));
    }
  }
  return out.slice(0, 300);
}

function bulkRedirect(res: Response, tab: string): void {
  res.redirect(tab && tab !== "active" ? `/workers?status=${encodeURIComponent(tab)}` : "/workers");
}

// Status / move-site / restore (capabilities mirror the individual routes:
// status+move need enroll_worker, restore needs delete_worker).
router.post("/workers/bulk", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const action = String(req.body.action ?? "");
  const tab = String(req.body.tab ?? "");
  const ids = parseBulkIds(req.body.ids);
  if (!ids.length) {
    flash(req, "danger", "No employees selected.");
    return bulkRedirect(res, tab);
  }

  let targetSite: { _id: Types.ObjectId; name: string } | null = null;
  if (action === "move-site") {
    const siteId = String(req.body.siteId ?? "");
    if (!Types.ObjectId.isValid(siteId) || !canUseSite(u, siteId)) {
      flash(req, "danger", "Pick a site you're assigned to.");
      return bulkRedirect(res, tab);
    }
    const site = await ProjectSiteModel.findById(siteId).select("name status").lean();
    if (!site || site.status !== "active") {
      flash(req, "danger", "That site is not active.");
      return bulkRedirect(res, tab);
    }
    targetSite = { _id: site._id, name: site.name };
  } else if (action === "restore") {
    if (!can(u.role, "delete_worker")) {
      flash(req, "danger", "You cannot restore employees.");
      return bulkRedirect(res, tab);
    }
  } else if (action !== "status-active" && action !== "status-inactive") {
    flash(req, "danger", "Unknown bulk action.");
    return bulkRedirect(res, tab);
  }

  const workers = await WorkerModel.find({ _id: { $in: ids } });
  let done = 0;
  let skipped = ids.length - workers.length;
  for (const w of workers) {
    if (!canUseWorker(u, w)) { skipped++; continue; }
    if (action === "restore") {
      if (w.status !== "archived") { skipped++; continue; }
      w.status = "active";
      w.deletedAt = null;
      w.deletedBy = null;
      pushRemark(w, u, "Employee restored.", "note");
    } else if (w.status === "archived" || w.status === "deleted") {
      skipped++; continue;
    } else if (action === "status-active" || action === "status-inactive") {
      w.status = action === "status-active" ? "active" : "inactive";
    } else {
      // move-site: same semantics as the individual edit — sites outside the
      // actor's scope are never silently dropped from the worker.
      const retained = w.siteIds.map(String).filter((id) => !canUseSite(u, id) && id !== String(targetSite!._id));
      w.siteIds = [targetSite!._id, ...retained.map((id) => new Types.ObjectId(id))] as never;
      w.siteId = targetSite!._id;
      w.siteName = targetSite!.name;
      pushRemark(w, u, `Moved to site "${targetSite!.name}" (bulk update).`, "note");
    }
    await w.save();
    done++;
  }
  const label =
    action === "restore" ? "restored" :
    action === "move-site" ? `moved to ${targetSite!.name}` :
    action === "status-active" ? "set Active" : "set Inactive";
  flash(req, done ? "success" : "danger", `${done} employee(s) ${label}.${skipped ? ` ${skipped} skipped.` : ""}`);
  bulkRedirect(res, action === "restore" ? "archived" : tab);
});

// Bulk archive/delete, step 1: one confirm page for the whole selection.
router.get("/workers/bulk/delete", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const ids = parseBulkIds(req.query.ids);
  const workers = (await WorkerModel.find({ _id: { $in: ids }, status: { $nin: ["archived", "deleted"] } }).select("name empRegNo siteName").lean())
    .filter((w) => canUseWorker(u, w));
  if (!workers.length) {
    flash(req, "danger", "No employees selected.");
    return res.redirect("/workers");
  }
  res.render("workers/bulk-delete", {
    title: `Delete ${workers.length} employees · ` + res.locals.company,
    active: "/workers",
    workers,
    ids: workers.map((w) => String(w._id)).join(","),
  });
});

// Bulk archive/delete, step 2 — same two levels as the individual delete,
// one reason for the batch, one Deletion log entry per deleted employee.
router.post("/workers/bulk/delete", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const ids = parseBulkIds(req.body.ids);
  const mode = req.body.mode === "delete" ? "delete" : "archive";
  const reason = String(req.body.reason ?? "").trim();
  if (!reason) {
    flash(req, "danger", "A reason is required.");
    return res.redirect(`/workers/bulk/delete?ids=${ids.join(",")}`);
  }
  const workers = await WorkerModel.find({ _id: { $in: ids }, status: { $nin: ["archived", "deleted"] } });
  let done = 0;
  let skipped = ids.length - workers.length;
  for (const w of workers) {
    if (!canUseWorker(u, w)) { skipped++; continue; }
    w.status = mode === "delete" ? "deleted" : "archived";
    w.deletedAt = new Date();
    w.deletedBy = new Types.ObjectId(u.id);
    pushRemark(w, u, reason, "soft_delete");
    await w.save();
    if (mode === "delete") {
      await DeletionLogModel.create({
        entityType: "worker",
        entityId: w._id,
        name: w.name,
        detail: w.empRegNo,
        siteName: w.siteName,
        photoUrl: w.photoUrl,
        deletedById: new Types.ObjectId(u.id),
        deletedByName: u.name,
        reason,
      });
    }
    done++;
  }
  flash(req, done ? "success" : "danger",
    `${done} employee(s) ${mode === "delete" ? "deleted (recorded in the Deletion log)" : "sent to Archives"}.${skipped ? ` ${skipped} skipped.` : ""}`);
  res.redirect("/workers");
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

// ---- View (read-only detail) — registered AFTER /workers/new so "new" wins ----
router.get("/workers/:id", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const worker = await WorkerModel.findById(req.params.id).lean();
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  // Resolve site names (multi-site), keeping order so the first is the primary.
  const ids = worker.siteIds && worker.siteIds.length ? worker.siteIds : [worker.siteId];
  const sites = await ProjectSiteModel.find({ _id: { $in: ids } }).lean();
  const byId = new Map(sites.map((s) => [String(s._id), s]));
  const siteList = ids.map((id) => byId.get(String(id))).filter(Boolean);
  res.render("workers/view", {
    title: worker.name + " · " + res.locals.company,
    active: "/workers",
    worker,
    siteList,
    hasFace: Array.isArray(worker.faceEncoding) && worker.faceEncoding.length > 0,
    canDelete: can(req.currentUser!.role, "delete_worker"),
  });
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
  if (worker.status === "archived" || worker.status === "deleted") {
    flash(req, "danger", "Restore this employee before editing.");
    return res.redirect("/workers?status=archived");
  }
  const name = String(req.body.name ?? "").trim();
  const empRegNo = String(req.body.empRegNo ?? "").trim();
  const submitted = parseSiteIds(req.body);
  const status = req.body.status === "inactive" ? "inactive" : "active";
  if (!name || !empRegNo || !submitted.length) {
    flash(req, "danger", "Employee ID, name, and at least one site are required.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  if (empRegNo !== worker.empRegNo && (await WorkerModel.findOne({ empRegNo, _id: { $ne: worker._id } }))) {
    flash(req, "danger", `Employee ID "${empRegNo}" is already in use.`);
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
  const empRegNoChanged = empRegNo !== worker.empRegNo;
  worker.empRegNo = empRegNo;
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
  try {
    await worker.save();
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Employee ID "${empRegNo}" is already in use.` : "Could not update employee.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  // Keep the denormalized empRegNo in sync wherever it was copied — attendance
  // history — when the Employee ID is actually changed.
  if (empRegNoChanged) {
    await AttendanceModel.updateMany({ workerId: worker._id }, { $set: { empRegNo } });
  }

  flash(req, "success", "Employee updated.");
  res.redirect("/workers");
});

// ---- Delete, step 1: the confirm page (choose Archive or Delete + reason) ----
router.get("/workers/:id/delete", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const worker = await WorkerModel.findById(req.params.id).lean();
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  if (worker.status === "deleted") {
    flash(req, "danger", "Employee is already deleted.");
    return res.redirect("/workers");
  }
  res.render("workers/delete", {
    title: `Delete ${worker.name} · ` + res.locals.company,
    active: "/workers",
    worker,
  });
});

// ---- Delete, step 2 — Archive (restorable) or Delete (hidden + logged).
// Neither erases the record: attendance / OT / payroll history stays intact.
router.post("/workers/:id/delete", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const reason = String(req.body.reason ?? "").trim();
  const mode = req.body.mode === "delete" ? "delete" : "archive";
  if (!reason) {
    flash(req, "danger", "A reason is required.");
    return res.redirect(`/workers/${req.params.id}/delete`);
  }
  if (worker.status === "deleted") {
    flash(req, "danger", "Employee is already deleted.");
    return res.redirect("/workers");
  }
  const u = req.currentUser!;
  worker.status = mode === "delete" ? "deleted" : "archived";
  worker.deletedAt = new Date();
  worker.deletedBy = new Types.ObjectId(u.id);
  pushRemark(worker, u, reason, "soft_delete");
  await worker.save();
  if (mode === "delete") {
    await DeletionLogModel.create({
      entityType: "worker",
      entityId: worker._id,
      name: worker.name,
      detail: worker.empRegNo,
      siteName: worker.siteName,
      photoUrl: worker.photoUrl,
      deletedById: new Types.ObjectId(u.id),
      deletedByName: u.name,
      reason,
    });
    flash(req, "success", `Employee ${worker.name} deleted. A record was kept in the Deletion log.`);
  } else {
    flash(req, "success", `Employee ${worker.name} sent to Archives.`);
  }
  res.redirect("/workers");
});

// ---- Restore (admin) — archived → active ----
router.post("/workers/:id/restore", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseWorker(req.currentUser!, worker)) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  if (worker.status !== "archived") {
    flash(req, "danger", "Only an archived employee can be restored.");
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
