import { Router, Request, Response } from "express";

import { requireCapability, requireRole } from "../auth/middleware";
import { escapeRegex, isDuplicateKeyError } from "../lib/validate";
import { AttendanceModel } from "../models/Attendance";
import { DesignationModel } from "../models/Designation";
import { WorkerModel } from "../models/Worker";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

// All roles (Supervisor and above) can view + add designations (spec §3/§4).
router.get("/designations", requireCapability("add_designation"), async (_req: Request, res: Response) => {
  const [all, counts] = await Promise.all([
    DesignationModel.find().sort({ name: 1 }).lean(),
    WorkerModel.aggregate([
      { $match: { status: { $in: ["active", "inactive"] } } },
      { $group: { _id: "$designationId", n: { $sum: 1 } } },
    ]),
  ]);
  const countById = new Map<string, number>(counts.map((c) => [String(c._id), c.n as number]));
  const designations = all.map((d) => ({ ...d, workers: countById.get(String(d._id)) ?? 0 }));
  const inUse = designations.filter((d) => d.workers > 0).length;
  res.render("designations/index", {
    title: "Designations · " + res.locals.company,
    active: "/designations",
    designations,
    summary: { total: all.length, inUse, unused: all.length - inUse },
    canManage: res.locals.can("manage_users"),
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
  const before = await DesignationModel.findById(req.params.id).select("name").lean();
  await DesignationModel.findByIdAndUpdate(req.params.id, { name });
  // Propagate the new name to the denormalized designationName on workers + attendance.
  if (before && before.name !== name) {
    await Promise.all([
      WorkerModel.updateMany({ designationId: req.params.id }, { $set: { designationName: name } }),
      AttendanceModel.updateMany({ designationId: req.params.id }, { $set: { designationName: name } }),
    ]);
  }
  flash(req, "success", "Designation updated.");
  res.redirect("/designations");
});

// Delete — blocked only while employees still ON THE ROSTER carry this
// designation (pending/active/inactive). Archived and deleted employees don't
// count: they're hidden from editing already (a restore is required first),
// so a since-deleted designation can't block anyone from being edited — and
// their denormalized designationName on the worker/attendance docs is
// untouched by removing the parent Designation record.
router.post("/designations/:id/delete", requireRole("management", "hr"), async (req: Request, res: Response) => {
  const count = await WorkerModel.countDocuments({
    designationId: req.params.id,
    status: { $in: ["pending", "active", "inactive"] },
  });
  if (count > 0) {
    flash(req, "danger", `${count} employee(s) use this designation — reassign them first.`);
    return res.redirect("/designations");
  }
  await DesignationModel.findByIdAndDelete(req.params.id);
  flash(req, "success", "Designation deleted.");
  res.redirect("/designations");
});

export default router;
