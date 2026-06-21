import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { seesAllSites } from "../auth/permissions";
import { isValidTime, endAfterStart, isDuplicateKeyError } from "../lib/validate";
import { BranchModel } from "../models/Branch";
import { ProjectSiteModel } from "../models/ProjectSite";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

// ---- Overview: branches + project sites ----
// Admin roles see everything; PM/Supervisor see only their assigned sites
// (read-only — the add/edit controls are gated on manage_org in the view).
router.get("/org", requireCapability("view_org"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const siteFilter = seesAllSites(u.role)
    ? {}
    : { _id: { $in: u.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
  const sites = await ProjectSiteModel.find(siteFilter).sort({ name: 1 }).lean();

  // Only the branches that contain the visible sites (for scoped roles).
  const branchFilter = seesAllSites(u.role)
    ? {}
    : { _id: { $in: [...new Set(sites.map((s) => String(s.branchId)))].map((id) => new Types.ObjectId(id)) } };
  const branches = await BranchModel.find(branchFilter).sort({ name: 1 }).lean();

  const branchNameById = new Map(branches.map((b) => [String(b._id), b.name]));
  res.render("org/index", {
    title: "Branches & Sites · " + res.locals.company,
    active: "/org",
    branches,
    sites,
    branchNameById,
  });
});

// ---- Branches ----
router.post("/org/branches", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) {
    flash(req, "danger", "Branch name is required.");
    return res.redirect("/org");
  }
  try {
    await BranchModel.create({ name });
    flash(req, "success", `Branch "${name}" added.`);
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Branch "${name}" already exists.` : "Could not add branch.");
  }
  res.redirect("/org");
});

router.get("/org/branches/:id/edit", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const branch = await BranchModel.findById(req.params.id).lean();
  if (!branch) {
    flash(req, "danger", "Branch not found.");
    return res.redirect("/org");
  }
  res.render("org/branch-edit", {
    title: "Edit branch · " + res.locals.company,
    active: "/org",
    branch,
  });
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
    res.redirect("/org");
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Branch "${name}" already exists.` : "Could not update branch.");
    res.redirect(`/org/branches/${req.params.id}/edit`);
  }
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
  const lat = parseCoord(req.body.latitude, -90, 90);
  const lng = parseCoord(req.body.longitude, -180, 180);
  const rad = parseCoord(req.body.geofenceRadiusMeters, 1, 100000);
  const nightShiftEnabled = req.body.nightShiftEnabled === "on" || req.body.nightShiftEnabled === "true";

  let error: string | undefined;
  if (!branchId || !name || !code) error = "Branch, name, and code are required.";
  else if (!isValidTime(start) || !isValidTime(end)) error = "Shift times must be valid HH:MM (24-hour).";
  else if (!endAfterStart(start, end)) error = "Shift end must be after shift start.";
  else if (lat === undefined || lng === undefined) error = "Latitude must be -90..90 and longitude -180..180.";
  else if (rad === undefined) error = "Radius must be a positive number of metres.";
  else if ((lat === null) !== (lng === null)) error = "Set both latitude and longitude, or leave both blank.";

  return {
    branchId,
    name,
    code,
    start,
    end,
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

router.post("/org/sites", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const { branchId, name, code, start, end, latitude, longitude, radius, address, inChargeName, inChargePhone, clientName, nightShiftEnabled, error } = parseSite(req);
  if (error) {
    flash(req, "danger", error);
    return res.redirect("/org");
  }
  const branch = await BranchModel.findById(branchId);
  if (!branch) {
    flash(req, "danger", "Selected branch does not exist.");
    return res.redirect("/org");
  }
  try {
    await ProjectSiteModel.create({
      branchId,
      name,
      code,
      standardStartTime: start,
      standardEndTime: end,
      latitude,
      longitude,
      geofenceRadiusMeters: radius,
      address,
      inChargeName,
      inChargePhone,
      clientName,
      nightShiftEnabled,
    });
    flash(req, "success", `Site "${name}" (${code}) added.`);
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Site code "${code}" already exists.` : "Could not add site.");
  }
  res.redirect("/org");
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
  res.render("org/site-edit", {
    title: "Edit site · " + res.locals.company,
    active: "/org",
    site,
    branches,
  });
});

router.post("/org/sites/:id", requireCapability("manage_sites"), async (req: Request, res: Response) => {
  const { branchId, name, code, start, end, latitude, longitude, radius, address, inChargeName, inChargePhone, clientName, nightShiftEnabled, error } = parseSite(req);
  if (error) {
    flash(req, "danger", error);
    return res.redirect(`/org/sites/${req.params.id}/edit`);
  }
  try {
    await ProjectSiteModel.findByIdAndUpdate(req.params.id, {
      branchId,
      name,
      code,
      standardStartTime: start,
      standardEndTime: end,
      latitude,
      longitude,
      geofenceRadiusMeters: radius,
      address,
      inChargeName,
      inChargePhone,
      clientName,
      nightShiftEnabled,
    });
    flash(req, "success", "Site updated.");
    res.redirect("/org");
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Site code "${code}" already exists.` : "Could not update site.");
    res.redirect(`/org/sites/${req.params.id}/edit`);
  }
});

export default router;
