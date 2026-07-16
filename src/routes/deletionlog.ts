import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { pushRemark } from "../lib/remarks";
import { DeletionLogModel } from "../models/DeletionLog";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

// ---- The deletion register (HR + Management) ----
// Every "delete" of an employee or site writes one immutable entry here: who,
// when, why, and (for sites) how many employees were cascaded. The page is the
// answer to "where did X go?" long after X vanished from the app.
router.get("/deletion-log", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  // Strictly one register per page: the Employees page links here with
  // type=worker, the Sites page with type=site — the two are never mixed.
  const type = req.query.type === "site" ? "site" : "worker";
  const [entries, workerCount, siteCount] = await Promise.all([
    DeletionLogModel.find({ entityType: type }).sort({ createdAt: -1 }).limit(500).lean(),
    DeletionLogModel.countDocuments({ entityType: "worker" }),
    DeletionLogModel.countDocuments({ entityType: "site" }),
  ]);
  res.render("deletionlog/index", {
    title: "Deletion log · " + res.locals.company,
    active: "/workers",
    entries,
    type,
    counts: { worker: workerCount, site: siteCount },
    isManagement: req.currentUser!.role === "management",
  });
});

// ---- Undo (Management only) — un-hides the record back into Archives. ----
// The log entry itself is kept (marked restored), so the register stays complete.
router.post("/deletion-log/:id/undo", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  if (u.role !== "management") {
    flash(req, "danger", "Only Management can undo a deletion.");
    return res.redirect("/deletion-log");
  }
  const entry = Types.ObjectId.isValid(req.params.id) ? await DeletionLogModel.findById(req.params.id) : null;
  if (!entry) {
    flash(req, "danger", "Log entry not found.");
    return res.redirect("/deletion-log");
  }
  if (entry.restoredAt) {
    flash(req, "danger", "This deletion was already undone.");
    return res.redirect("/deletion-log");
  }

  if (entry.entityType === "worker") {
    const worker = await WorkerModel.findById(entry.entityId);
    if (!worker || worker.status !== "deleted") {
      flash(req, "danger", "The employee record is no longer in a deleted state.");
      return res.redirect("/deletion-log");
    }
    worker.status = "archived";
    pushRemark(worker, u, "Deletion undone from the Deletion log — moved to Archives.", "note");
    await worker.save();
  } else {
    const site = await ProjectSiteModel.findById(entry.entityId);
    if (!site || site.status !== "deleted") {
      flash(req, "danger", "The site record is no longer in a deleted state.");
      return res.redirect("/deletion-log");
    }
    site.status = "archived";
    site.archivedAt = new Date();
    site.archivedBy = new Types.ObjectId(u.id);
    site.archivedByName = u.name;
    site.deletedAt = null;
    site.deletedBy = null;
    await site.save();
  }

  entry.restoredAt = new Date();
  entry.restoredById = new Types.ObjectId(u.id);
  entry.restoredByName = u.name;
  await entry.save();
  flash(req, "success", `"${entry.name}" restored to Archives.`);
  res.redirect("/deletion-log");
});

export default router;
