import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { seesAllSites } from "../auth/permissions";
import { isValidTime, endAfterStart, isDuplicateKeyError, escapeRegex } from "../lib/validate";
import { BranchModel } from "../models/Branch";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

/** Distinct, sorted in-charge names for the autocomplete datalist. */
async function inChargeNames(): Promise<string[]> {
  return ((await ProjectSiteModel.distinct("inChargeName")) as (string | null)[])
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b));
}

// ---- Sites ledger (the hero page) ----
// Admin roles see every site; PM/Supervisor see only their assigned sites.
router.get("/org", requireCapability("view_org"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const q = String(req.query.q ?? "").trim();
  const scopeFilter = seesAllSites(u.role)
    ? {}
    : { _id: { $in: u.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };

  const [allScopeSites, allBranches, wc] = await Promise.all([
    ProjectSiteModel.find(scopeFilter).sort({ name: 1 }).lean(),
    BranchModel.find().sort({ name: 1 }).lean(),
    WorkerModel.aggregate([
      { $match: { status: { $in: ["active", "inactive"] } } },
      { $unwind: "$siteIds" },
      { $group: { _id: "$siteIds", n: { $sum: 1 } } },
    ]),
  ]);
  const workerCount = new Map<string, number>(wc.map((w) => [String(w._id), w.n as number]));
  const branchNameById = new Map(allBranches.map((b) => [String(b._id), b.name]));
  const visibleBranches = seesAllSites(u.role)
    ? allBranches
    : allBranches.filter((b) => allScopeSites.some((s) => String(s.branchId) === String(b._id)));

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
    sites: allScopeSites.length,
    branches: visibleBranches.length,
    geofenced: allScopeSites.filter((s) => s.latitude != null && s.longitude != null).length,
    nightShift: allScopeSites.filter((s) => s.nightShiftEnabled).length,
  };

  res.render("org/index", {
    title: "Sites · " + res.locals.company,
    active: "/org",
    sites: rows,
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
  const sc = await ProjectSiteModel.aggregate([{ $group: { _id: "$branchId", n: { $sum: 1 } } }]);
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
  const siteCount = await ProjectSiteModel.countDocuments({ branchId: req.params.id });
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
  latitude: number | null;
  longitude: number | null;
  radius: number | null;
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

  let error: string | undefined;
  if (!branchId || !name || !code) error = "Branch, name, and code are required.";
  else if (!isValidTime(start) || !isValidTime(end)) error = "Day shift times must be valid HH:MM (24-hour).";
  else if (!endAfterStart(start, end)) error = "Day shift end must be after its start.";
  else if (nightShiftEnabled && (!isValidTime(nightStart) || !isValidTime(nightEnd))) error = "Night shift times must be valid HH:MM (24-hour).";
  else if (!allowedValid) error = "Allowed OT hours must be a number between 0 and 24.";
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
    latitude: lat === undefined ? null : lat,
    longitude: lng === undefined ? null : lng,
    radius: rad === undefined ? null : rad,
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
      latitude: p.latitude,
      longitude: p.longitude,
      geofenceRadiusMeters: p.radius,
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
      latitude: p.latitude,
      longitude: p.longitude,
      geofenceRadiusMeters: p.radius,
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
    await ProjectSiteModel.findByIdAndUpdate(req.params.id, update);
    flash(req, "success", "Site updated.");
    res.redirect(`/org/sites/${req.params.id}`);
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Site code "${p.code}" already exists.` : "Could not update site.");
    res.redirect(`/org/sites/${req.params.id}/edit`);
  }
});

// Delete a site — blocked while employees are still assigned to it.
router.post("/org/sites/:id/delete", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const workerCount = await WorkerModel.countDocuments({ siteIds: req.params.id });
  if (workerCount > 0) {
    flash(req, "danger", `Reassign this site's ${workerCount} employee(s) first.`);
    return res.redirect("/org");
  }
  await ProjectSiteModel.findByIdAndDelete(req.params.id);
  flash(req, "success", "Site deleted.");
  res.redirect("/org");
});

export default router;
