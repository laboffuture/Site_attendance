import { Router, Request, Response } from "express";

import { requireCapability } from "../auth/middleware";
import { isValidTime, endAfterStart, isDuplicateKeyError } from "../lib/validate";
import { BranchModel } from "../models/Branch";
import { ProjectSiteModel } from "../models/ProjectSite";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

// ---- Overview: branches + project sites ----
router.get("/org", requireCapability("view_org"), async (_req: Request, res: Response) => {
  const [branches, sites] = await Promise.all([
    BranchModel.find().sort({ name: 1 }).lean(),
    ProjectSiteModel.find().sort({ name: 1 }).lean(),
  ]);
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
function parseSite(req: Request): {
  branchId: string;
  name: string;
  code: string;
  start: string;
  end: string;
  error?: string;
} {
  const branchId = String(req.body.branchId ?? "").trim();
  const name = String(req.body.name ?? "").trim();
  const code = String(req.body.code ?? "").trim().toUpperCase();
  const start = String(req.body.standardStartTime ?? "").trim();
  const end = String(req.body.standardEndTime ?? "").trim();

  let error: string | undefined;
  if (!branchId || !name || !code) error = "Branch, name, and code are required.";
  else if (!isValidTime(start) || !isValidTime(end)) error = "Shift times must be valid HH:MM (24-hour).";
  else if (!endAfterStart(start, end)) error = "Shift end must be after shift start.";

  return { branchId, name, code, start, end, error };
}

router.post("/org/sites", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const { branchId, name, code, start, end, error } = parseSite(req);
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
    });
    flash(req, "success", `Site "${name}" (${code}) added.`);
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Site code "${code}" already exists.` : "Could not add site.");
  }
  res.redirect("/org");
});

router.get("/org/sites/:id/edit", requireCapability("manage_org"), async (req: Request, res: Response) => {
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

router.post("/org/sites/:id", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const { branchId, name, code, start, end, error } = parseSite(req);
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
    });
    flash(req, "success", "Site updated.");
    res.redirect("/org");
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Site code "${code}" already exists.` : "Could not update site.");
    res.redirect(`/org/sites/${req.params.id}/edit`);
  }
});

export default router;
