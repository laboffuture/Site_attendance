import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { seesAllSites } from "../auth/permissions";
import type { CurrentUser } from "../auth/types";
import { pushRemark } from "../lib/remarks";
import { isValidTime, endAfterStart, isDuplicateKeyError, escapeRegex } from "../lib/validate";
import { AttendanceModel } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { DeletionLogModel } from "../models/DeletionLog";
import { ProjectSiteModel } from "../models/ProjectSite";
import { SiteStationModel } from "../models/SiteStation";
import { UserModel } from "../models/User";
import { WorkerModel } from "../models/Worker";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

type SiteDoc = { _id: Types.ObjectId; name: string };

/**
 * Cascade a site archive/delete to the employees assigned to it.
 * A worker who also belongs to ANOTHER active site just loses this site from
 * their list and stays active ("detached"). Sole-site workers are archived —
 * or, when workerMode is "delete", hidden-deleted with a Deletion log entry
 * each. Nothing is erased; attendance/OT/payroll history is untouched.
 */
async function cascadeSiteWorkers(
  site: SiteDoc,
  u: CurrentUser,
  siteAction: "archived" | "deleted",
  workerMode: "archive" | "delete",
): Promise<{ archived: number; deleted: number; detached: number }> {
  const [workers, otherSites] = await Promise.all([
    WorkerModel.find({ siteIds: site._id, status: { $in: ["pending", "active", "inactive"] } }),
    ProjectSiteModel.find({ status: "active", _id: { $ne: site._id } }).select("_id").lean(),
  ]);
  const otherActive = new Set(otherSites.map((s) => String(s._id)));
  const out = { archived: 0, deleted: 0, detached: 0 };
  for (const w of workers) {
    const others = w.siteIds.map(String).filter((id) => id !== String(site._id) && otherActive.has(id));
    if (others.length) {
      w.siteIds = w.siteIds.filter((id) => String(id) !== String(site._id)) as never;
      pushRemark(w, u, `Removed from site "${site.name}" (site ${siteAction}); still assigned to ${others.length} other site(s).`, "note");
      out.detached++;
    } else if (workerMode === "delete") {
      w.status = "deleted";
      w.deletedAt = new Date();
      w.deletedBy = new Types.ObjectId(u.id);
      pushRemark(w, u, `Site "${site.name}" was ${siteAction} — employee deleted with it.`, "soft_delete");
      await DeletionLogModel.create({
        entityType: "worker",
        entityId: w._id,
        name: w.name,
        detail: w.empRegNo,
        siteName: w.siteName,
        photoUrl: w.photoUrl,
        deletedById: new Types.ObjectId(u.id),
        deletedByName: u.name,
        reason: `Deleted together with site "${site.name}".`,
      });
      out.deleted++;
    } else {
      w.status = "archived";
      w.deletedAt = new Date();
      w.deletedBy = new Types.ObjectId(u.id);
      pushRemark(w, u, `Site "${site.name}" was ${siteAction} — employee sent to Archives.`, "soft_delete");
      out.archived++;
    }
    await w.save();
  }
  return out;
}

function cascadeSummary(c: { archived: number; deleted: number; detached: number }): string {
  const parts: string[] = [];
  if (c.archived) parts.push(`${c.archived} employee(s) archived`);
  if (c.deleted) parts.push(`${c.deleted} employee(s) deleted`);
  if (c.detached) parts.push(`${c.detached} kept active on their other site(s)`);
  return parts.length ? ` ${parts.join(", ")}.` : "";
}

/** Distinct, sorted in-charge names for the autocomplete datalist. */
async function inChargeNames(): Promise<string[]> {
  return ((await ProjectSiteModel.distinct("inChargeName")) as (string | null)[])
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b));
}

// ---- Sites ledger (the hero page) ----
// Admin roles see every site; PM/Supervisor see only their assigned sites.
// Two tabs: Active | Archived (signed-off). Deleted sites appear in neither —
// they live in the Deletion log.
router.get("/org", requireCapability("view_org"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const q = String(req.query.q ?? "").trim();
  const tab = String(req.query.status) === "archived" ? "archived" : "active";
  const scopeFilter = seesAllSites(u.role)
    ? {}
    : { _id: { $in: u.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };

  const [activeSites, archivedSites, allBranches, wc] = await Promise.all([
    ProjectSiteModel.find({ ...scopeFilter, status: "active" }).sort({ name: 1 }).lean(),
    ProjectSiteModel.find({ ...scopeFilter, status: "archived" }).sort({ name: 1 }).lean(),
    BranchModel.find().sort({ name: 1 }).lean(),
    WorkerModel.aggregate([
      { $match: { status: { $in: ["active", "inactive"] } } },
      { $unwind: "$siteIds" },
      { $group: { _id: "$siteIds", n: { $sum: 1 } } },
    ]),
  ]);
  const allScopeSites = tab === "archived" ? archivedSites : activeSites;
  const workerCount = new Map<string, number>(wc.map((w) => [String(w._id), w.n as number]));
  const branchNameById = new Map(allBranches.map((b) => [String(b._id), b.name]));
  const visibleBranches = seesAllSites(u.role)
    ? allBranches
    : allBranches.filter((b) => activeSites.some((s) => String(s.branchId) === String(b._id)));

  // Filters (in-memory — sites are few).
  const reqBranchId = String(req.query.branchId ?? "");
  const selectedBranchId = visibleBranches.some((b) => String(b._id) === reqBranchId) ? reqBranchId : "";
  let listed = allScopeSites;
  if (selectedBranchId) listed = listed.filter((s) => String(s.branchId) === selectedBranchId);
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    listed = listed.filter((s) => rx.test(s.name) || rx.test(s.code));
  }
  const rows = listed.map((s) => ({ ...s, workers: workerCount.get(String(s._id)) ?? 0 }));

  const summary = {
    sites: activeSites.length,
    branches: visibleBranches.length,
    geofenced: activeSites.filter((s) => s.latitude != null && s.longitude != null).length,
    nightShift: activeSites.filter((s) => s.nightShiftEnabled).length,
  };

  res.render("org/index", {
    title: "Sites · " + res.locals.company,
    active: "/org",
    sites: rows,
    tab,
    counts: { active: activeSites.length, archived: archivedSites.length },
    branches: visibleBranches,
    branchNameById,
    summary,
    q,
    selectedBranchId,
  });
});

// ---- Branches (own management page) ----
router.get("/org/branches", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const branches = await BranchModel.find().sort({ name: 1 }).lean();
  const sc = await ProjectSiteModel.aggregate([
    { $match: { status: { $ne: "deleted" } } },
    { $group: { _id: "$branchId", n: { $sum: 1 } } },
  ]);
  const siteCount = new Map<string, number>(sc.map((s) => [String(s._id), s.n as number]));
  const rows = branches.map((b) => ({ ...b, sites: siteCount.get(String(b._id)) ?? 0 }));
  res.render("org/branches", { title: "Branches · " + res.locals.company, active: "/org", branches: rows });
});

router.post("/org/branches", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) {
    flash(req, "danger", "Branch name is required.");
    return res.redirect("/org/branches");
  }
  try {
    await BranchModel.create({ name });
    flash(req, "success", `Branch "${name}" added.`);
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Branch "${name}" already exists.` : "Could not add branch.");
  }
  res.redirect("/org/branches");
});

router.get("/org/branches/:id/edit", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const branch = await BranchModel.findById(req.params.id).lean();
  if (!branch) {
    flash(req, "danger", "Branch not found.");
    return res.redirect("/org/branches");
  }
  res.render("org/branch-edit", { title: "Edit branch · " + res.locals.company, active: "/org", branch });
});

router.post("/org/branches/:id", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) {
    flash(req, "danger", "Branch name is required.");
    return res.redirect(`/org/branches/${req.params.id}/edit`);
  }
  try {
    await BranchModel.findByIdAndUpdate(req.params.id, { name });
    flash(req, "success", "Branch updated.");
    res.redirect("/org/branches");
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Branch "${name}" already exists.` : "Could not update branch.");
    res.redirect(`/org/branches/${req.params.id}/edit`);
  }
});

// Delete a branch — blocked while it still has sites (no orphaned sites).
router.post("/org/branches/:id/delete", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const siteCount = await ProjectSiteModel.countDocuments({ branchId: req.params.id, status: { $ne: "deleted" } });
  if (siteCount > 0) {
    flash(req, "danger", `Delete or move this branch's ${siteCount} site(s) first.`);
    return res.redirect("/org/branches");
  }
  await BranchModel.findByIdAndDelete(req.params.id);
  flash(req, "success", "Branch deleted.");
  res.redirect("/org/branches");
});

// ---- Project sites ----
function parseCoord(v: unknown, lo: number, hi: number): number | null | undefined {
  const s = String(v ?? "").trim();
  if (s === "") return null; // explicitly cleared / not provided
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < lo || n > hi) return undefined; // invalid sentinel
  return n;
}

interface ParsedSite {
  branchId: string;
  name: string;
  code: string;
  start: string;
  end: string;
  nightStart: string;
  nightEnd: string;
  allowedOtHours: number | null;
  lunchHours: number;
  latitude: number | null;
  longitude: number | null;
  radius: number | null;
  geofencePolygon: number[][];
  address: string | null;
  inChargeName: string | null;
  inChargePhone: string | null;
  clientName: string | null;
  nightShiftEnabled: boolean;
  error?: string;
}

function parseSite(req: Request): ParsedSite {
  const branchId = String(req.body.branchId ?? "").trim();
  const name = String(req.body.name ?? "").trim();
  const code = String(req.body.code ?? "").trim().toUpperCase();
  const start = String(req.body.standardStartTime ?? "").trim();
  const end = String(req.body.standardEndTime ?? "").trim();
  const nightStart = String(req.body.nightStartTime ?? "").trim();
  const nightEnd = String(req.body.nightEndTime ?? "").trim();
  const lat = parseCoord(req.body.latitude, -90, 90);
  const lng = parseCoord(req.body.longitude, -180, 180);
  const rad = parseCoord(req.body.geofenceRadiusMeters, 1, 100000);
  const nightShiftEnabled = req.body.nightShiftEnabled === "on" || req.body.nightShiftEnabled === "true";
  const allowedRaw = String(req.body.allowedOtHours ?? "").trim();
  const allowedNum = parseFloat(allowedRaw);
  const allowedValid = allowedRaw === "" || (Number.isFinite(allowedNum) && allowedNum >= 0 && allowedNum <= 24);
  const lunchRaw = String(req.body.lunchHours ?? "").trim();
  const lunchNum = parseFloat(lunchRaw);
  const lunchValid = lunchRaw === "" || (Number.isFinite(lunchNum) && lunchNum >= 0 && lunchNum <= 8);

  // Drawn polygon geofence — [[lat, lng], ...] sent as JSON in a hidden field.
  let geofencePolygon: number[][] = [];
  try {
    const raw = JSON.parse(String(req.body.geofencePolygon ?? "[]"));
    if (Array.isArray(raw)) {
      geofencePolygon = raw
        .filter((p: unknown): p is number[] => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= -90 && p[0] <= 90 && p[1] >= -180 && p[1] <= 180)
        .map((p: number[]) => [p[0], p[1]]);
      if (geofencePolygon.length < 3) geofencePolygon = [];
    }
  } catch {
    geofencePolygon = [];
  }

  let error: string | undefined;
  if (!branchId || !name || !code) error = "Branch, name, and code are required.";
  else if (!isValidTime(start) || !isValidTime(end)) error = "Day shift times must be valid HH:MM (24-hour).";
  else if (!endAfterStart(start, end)) error = "Day shift end must be after its start.";
  else if (nightShiftEnabled && (!isValidTime(nightStart) || !isValidTime(nightEnd))) error = "Night shift times must be valid HH:MM (24-hour).";
  else if (!allowedValid) error = "Allowed OT hours must be a number between 0 and 24.";
  else if (!lunchValid) error = "Lunch deduction must be a number of hours between 0 and 8.";
  else if (lat === undefined || lng === undefined) error = "Latitude must be -90..90 and longitude -180..180.";
  else if (rad === undefined) error = "Radius must be a positive number of metres.";
  else if ((lat === null) !== (lng === null)) error = "Set both latitude and longitude, or leave both blank.";

  return {
    branchId,
    name,
    code,
    start,
    end,
    nightStart,
    nightEnd,
    allowedOtHours: allowedRaw === "" ? null : allowedNum,
    lunchHours: lunchRaw === "" ? 1 : lunchNum,
    latitude: lat === undefined ? null : lat,
    longitude: lng === undefined ? null : lng,
    radius: rad === undefined ? null : rad,
    geofencePolygon,
    address: String(req.body.address ?? "").trim() || null,
    inChargeName: String(req.body.inChargeName ?? "").trim() || null,
    inChargePhone: String(req.body.inChargePhone ?? "").trim() || null,
    clientName: String(req.body.clientName ?? "").trim() || null,
    nightShiftEnabled,
    error,
  };
}

// Dedicated "Add site" form.
router.get("/org/sites/new", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const [branches, inCharges] = await Promise.all([
    BranchModel.find().sort({ name: 1 }).lean(),
    inChargeNames(),
  ]);
  res.render("org/site-form", {
    title: "Add site · " + res.locals.company,
    active: "/org",
    mode: "new",
    site: null,
    branches,
    inCharges,
  });
});

router.post("/org/sites", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const p = parseSite(req);
  if (p.error) {
    flash(req, "danger", p.error);
    return res.redirect("/org/sites/new");
  }
  const branch = await BranchModel.findById(p.branchId);
  if (!branch) {
    flash(req, "danger", "Selected branch does not exist.");
    return res.redirect("/org/sites/new");
  }
  try {
    const site = await ProjectSiteModel.create({
      branchId: p.branchId,
      name: p.name,
      code: p.code,
      standardStartTime: p.start,
      standardEndTime: p.end,
      allowedOtHours: p.allowedOtHours,
      lunchHours: p.lunchHours,
      latitude: p.latitude,
      longitude: p.longitude,
      geofenceRadiusMeters: p.radius,
      geofencePolygon: p.geofencePolygon,
      address: p.address,
      inChargeName: p.inChargeName,
      inChargePhone: p.inChargePhone,
      clientName: p.clientName,
      nightShiftEnabled: p.nightShiftEnabled,
    });
    if (p.nightStart && p.nightEnd && site.shifts) {
      site.shifts.night.startTime = p.nightStart;
      site.shifts.night.endTime = p.nightEnd;
      await site.save();
    }
    flash(req, "success", `Site "${p.name}" (${p.code}) added.`);
    res.redirect(`/org/sites/${site._id}`);
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Site code "${p.code}" already exists.` : "Could not add site.");
    res.redirect("/org/sites/new");
  }
});

// Read-only site detail.
router.get("/org/sites/:id", requireCapability("view_org"), async (req: Request, res: Response) => {
  if (!Types.ObjectId.isValid(req.params.id)) {
    flash(req, "danger", "Site not found.");
    return res.redirect("/org");
  }
  const site = await ProjectSiteModel.findById(req.params.id).lean();
  if (!site) {
    flash(req, "danger", "Site not found.");
    return res.redirect("/org");
  }
  const u = req.currentUser!;
  if (!seesAllSites(u.role) && !u.assignedSiteIds.map(String).includes(String(site._id))) {
    flash(req, "danger", "That site isn't in your scope.");
    return res.redirect("/org");
  }
  const [branch, workers] = await Promise.all([
    BranchModel.findById(site.branchId).lean(),
    WorkerModel.countDocuments({ siteIds: site._id, status: { $in: ["active", "inactive"] } }),
  ]);
  res.render("org/view", {
    title: site.name + " · " + res.locals.company,
    active: "/org",
    site,
    branchName: branch?.name || "—",
    workers,
    canManage: res.locals.can("manage_sites"),
  });
});

router.get("/org/sites/:id/edit", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const [site, branches] = await Promise.all([
    ProjectSiteModel.findById(req.params.id).lean(),
    BranchModel.find().sort({ name: 1 }).lean(),
  ]);
  if (!site) {
    flash(req, "danger", "Site not found.");
    return res.redirect("/org");
  }
  res.render("org/site-form", {
    title: "Edit site · " + res.locals.company,
    active: "/org",
    mode: "edit",
    site,
    branches,
    inCharges: await inChargeNames(),
  });
});

router.post("/org/sites/:id", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const p = parseSite(req);
  if (p.error) {
    flash(req, "danger", p.error);
    return res.redirect(`/org/sites/${req.params.id}/edit`);
  }
  try {
    const update: Record<string, unknown> = {
      branchId: p.branchId,
      name: p.name,
      code: p.code,
      standardStartTime: p.start,
      standardEndTime: p.end,
      allowedOtHours: p.allowedOtHours,
      lunchHours: p.lunchHours,
      latitude: p.latitude,
      longitude: p.longitude,
      geofenceRadiusMeters: p.radius,
      geofencePolygon: p.geofencePolygon,
      address: p.address,
      inChargeName: p.inChargeName,
      inChargePhone: p.inChargePhone,
      clientName: p.clientName,
      nightShiftEnabled: p.nightShiftEnabled,
    };
    if (p.nightStart && p.nightEnd) {
      update["shifts.night.startTime"] = p.nightStart;
      update["shifts.night.endTime"] = p.nightEnd;
    }
    const before = await ProjectSiteModel.findById(req.params.id).select("name").lean();
    await ProjectSiteModel.findByIdAndUpdate(req.params.id, update);
    // Keep the denormalized siteName in sync wherever it was copied — primary-site
    // workers and their attendance — when the site is actually renamed.
    if (before && before.name !== p.name) {
      await Promise.all([
        WorkerModel.updateMany({ siteId: req.params.id }, { $set: { siteName: p.name } }),
        AttendanceModel.updateMany({ siteId: req.params.id }, { $set: { siteName: p.name } }),
      ]);
    }
    flash(req, "success", "Site updated.");
    res.redirect(`/org/sites/${req.params.id}`);
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Site code "${p.code}" already exists.` : "Could not update site.");
    res.redirect(`/org/sites/${req.params.id}/edit`);
  }
});

// ---- Sign off a completed site — archives the site AND its employees. ----
// The site disappears from active lists (restorable from the Archived tab);
// sole-site employees go to the employee Archives; multi-site employees just
// lose this site. Stations are deactivated. All history is kept.
router.post("/org/sites/:id/signoff", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const site = Types.ObjectId.isValid(req.params.id) ? await ProjectSiteModel.findById(req.params.id) : null;
  if (!site || site.status !== "active") {
    flash(req, "danger", "Only an active site can be signed off.");
    return res.redirect("/org");
  }
  const u = req.currentUser!;
  const counts = await cascadeSiteWorkers(site, u, "archived", "archive");
  site.status = "archived";
  site.archivedAt = new Date();
  site.archivedBy = new Types.ObjectId(u.id);
  site.archivedByName = u.name;
  await site.save();
  await SiteStationModel.updateMany({ projectSiteId: site._id }, { $set: { active: false } });
  flash(req, "success", `Site "${site.name}" signed off and archived.` + cascadeSummary(counts));
  res.redirect("/org?status=archived");
});

// ---- Restore an archived site (employees stay archived — restore them individually). ----
router.post("/org/sites/:id/restore", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const site = Types.ObjectId.isValid(req.params.id) ? await ProjectSiteModel.findById(req.params.id) : null;
  if (!site || site.status !== "archived") {
    flash(req, "danger", "Only an archived site can be restored.");
    return res.redirect("/org");
  }
  site.status = "active";
  site.archivedAt = null;
  site.archivedBy = null;
  site.archivedByName = null;
  await site.save();
  await SiteStationModel.updateMany({ projectSiteId: site._id }, { $set: { active: true } });
  flash(req, "success", `Site "${site.name}" restored. Its employees remain in Archives — restore them individually as needed.`);
  res.redirect("/org");
});

// ---- Delete, step 1: the confirm page (Archive vs Delete + employee fate). ----
router.get("/org/sites/:id/delete", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const site = Types.ObjectId.isValid(req.params.id) ? await ProjectSiteModel.findById(req.params.id).lean() : null;
  if (!site || site.status === "deleted") {
    flash(req, "danger", "Site not found.");
    return res.redirect("/org");
  }
  const [workers, otherSites] = await Promise.all([
    WorkerModel.find({ siteIds: site._id, status: { $in: ["pending", "active", "inactive"] } }).select("siteIds").lean(),
    ProjectSiteModel.find({ status: "active", _id: { $ne: site._id } }).select("_id").lean(),
  ]);
  const otherActive = new Set(otherSites.map((s) => String(s._id)));
  const multi = workers.filter((w) => w.siteIds.map(String).some((id) => id !== String(site._id) && otherActive.has(id))).length;
  res.render("org/delete", {
    title: `Delete ${site.name} · ` + res.locals.company,
    active: "/org",
    site,
    soleCount: workers.length - multi,
    multiCount: multi,
  });
});

// ---- Delete, step 2 — Archive (sign off) or Delete (hidden + logged). ----
// Delete cascades to employees per the chosen workerMode. The site record is
// never erased: reports and payroll for past periods stay intact, and the
// deletion is recorded in the Deletion log (Management can undo from there).
router.post("/org/sites/:id/delete", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const site = Types.ObjectId.isValid(req.params.id) ? await ProjectSiteModel.findById(req.params.id) : null;
  if (!site || site.status === "deleted") {
    flash(req, "danger", "Site not found.");
    return res.redirect("/org");
  }
  const u = req.currentUser!;
  const mode = req.body.mode === "delete" ? "delete" : "archive";
  const workerMode = req.body.workerMode === "delete" ? "delete" : "archive";
  const reason = String(req.body.reason ?? "").trim();
  if (!reason) {
    flash(req, "danger", "A reason is required.");
    return res.redirect(`/org/sites/${site._id}/delete`);
  }

  if (mode === "archive") {
    const counts = await cascadeSiteWorkers(site, u, "archived", "archive");
    site.status = "archived";
    site.archivedAt = new Date();
    site.archivedBy = new Types.ObjectId(u.id);
    site.archivedByName = u.name;
    await site.save();
    await SiteStationModel.updateMany({ projectSiteId: site._id }, { $set: { active: false } });
    flash(req, "success", `Site "${site.name}" archived.` + cascadeSummary(counts));
    return res.redirect("/org?status=archived");
  }

  const counts = await cascadeSiteWorkers(site, u, "deleted", workerMode);
  site.status = "deleted";
  site.deletedAt = new Date();
  site.deletedBy = new Types.ObjectId(u.id);
  await site.save();
  await Promise.all([
    SiteStationModel.updateMany({ projectSiteId: site._id }, { $set: { active: false } }),
    // Drop the site from PM/Supervisor scopes so their menus don't show it.
    UserModel.updateMany({ assignedSiteIds: site._id }, { $pull: { assignedSiteIds: site._id } }),
    DeletionLogModel.create({
      entityType: "site",
      entityId: site._id,
      name: site.name,
      detail: site.code,
      deletedById: new Types.ObjectId(u.id),
      deletedByName: u.name,
      reason,
      cascadeArchived: counts.archived,
      cascadeDeleted: counts.deleted,
    }),
  ]);
  flash(req, "success", `Site "${site.name}" deleted. A record was kept in the Deletion log.` + cascadeSummary(counts));
  res.redirect("/org");
});

export default router;
