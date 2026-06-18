import { Router, Request, Response } from "express";

import { requireCapability, requireRole } from "../auth/middleware";
import { escapeRegex, isDuplicateKeyError } from "../lib/validate";
import { DesignationModel } from "../models/Designation";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

// All roles (Supervisor and above) can view + add designations (spec §3/§4).
router.get("/designations", requireCapability("add_designation"), async (_req: Request, res: Response) => {
  const designations = await DesignationModel.find().sort({ name: 1 }).lean();
  res.render("designations/index", {
    title: "Designations · " + res.locals.company,
    active: "/designations",
    designations,
  });
});

router.post("/designations", requireCapability("add_designation"), async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) {
    flash(req, "danger", "Designation name is required.");
    return res.redirect("/designations");
  }
  // Case-insensitive duplicate guard (the unique index is case-sensitive).
  const existing = await DesignationModel.findOne({
    name: new RegExp(`^${escapeRegex(name)}$`, "i"),
  });
  if (existing) {
    flash(req, "danger", `Designation "${name}" already exists.`);
    return res.redirect("/designations");
  }
  try {
    await DesignationModel.create({ name });
    flash(req, "success", `Designation "${name}" added.`);
  } catch (err) {
    flash(req, "danger", isDuplicateKeyError(err) ? `Designation "${name}" already exists.` : "Could not add designation.");
  }
  res.redirect("/designations");
});

// Renaming is narrower than adding — Management/HR only.
router.get("/designations/:id/edit", requireRole("management", "hr"), async (req: Request, res: Response) => {
  const designation = await DesignationModel.findById(req.params.id).lean();
  if (!designation) {
    flash(req, "danger", "Designation not found.");
    return res.redirect("/designations");
  }
  res.render("designations/edit", {
    title: "Edit designation · " + res.locals.company,
    active: "/designations",
    designation,
  });
});

router.post("/designations/:id", requireRole("management", "hr"), async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) {
    flash(req, "danger", "Designation name is required.");
    return res.redirect(`/designations/${req.params.id}/edit`);
  }
  const existing = await DesignationModel.findOne({
    name: new RegExp(`^${escapeRegex(name)}$`, "i"),
    _id: { $ne: req.params.id },
  });
  if (existing) {
    flash(req, "danger", `Designation "${name}" already exists.`);
    return res.redirect(`/designations/${req.params.id}/edit`);
  }
  await DesignationModel.findByIdAndUpdate(req.params.id, { name });
  flash(req, "success", "Designation updated.");
  res.redirect("/designations");
});

export default router;
