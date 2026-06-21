import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { can, seesAllSites } from "../auth/permissions";
import type { CurrentUser } from "../auth/types";
import { siteScopeFilter, canUseSite } from "../lib/scope";
import { hmToHours, round2 } from "../lib/time";
import { isValidTime, endAfterStart } from "../lib/validate";
import { BranchModel } from "../models/Branch";
import { ProjectSiteModel } from "../models/ProjectSite";
import { RequestModel, REQUEST_TYPES } from "../models/Request";
import { WorkerModel } from "../models/Worker";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TABS = ["pending", "recommended", "decided", "all"] as const;

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

/** Workers the user may raise a request for (their sites). */
async function allowedWorkers(user: CurrentUser) {
  const scope = siteScopeFilter(user); // {} for admins, else {siteId:{$in}}
  return WorkerModel.find({ ...scope, status: "active" }).sort({ name: 1 }).lean();
}

// ---- List (role-scoped + tab) ----
router.get("/requests", requireCapability("view_requests"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const tab = (TABS as readonly string[]).includes(String(req.query.tab)) ? String(req.query.tab) : "pending";

  const query: Record<string, unknown> = { ...siteScopeFilter(u) };
  if (tab === "pending") query.status = "pending";
  else if (tab === "recommended") query.status = "recommended";
  else if (tab === "decided") query.status = { $in: ["approved", "rejected"] };

  const requests = await RequestModel.find(query).sort({ createdAt: -1 }).limit(500).lean();

  res.render("requests/index", {
    title: "Requests · " + res.locals.company,
    active: "/requests",
    requests,
    tab,
    canRecommend: can(u.role, "recommend_request"),
    canDecide: can(u.role, "decide_request"),
  });
});

// ---- New request form ----
router.get("/requests/new", requireCapability("create_request"), async (req: Request, res: Response) => {
  const workers = await allowedWorkers(req.currentUser!);
  const type = req.query.type === "offload" ? "offload" : "scheduled_ot";
  res.render("requests/new", {
    title: "New request · " + res.locals.company,
    active: "/requests",
    workers,
    type,
  });
});

// ---- Create ----
router.post("/requests", requireCapability("create_request"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const type = String(req.body.type ?? "");
  if (!(REQUEST_TYPES as readonly string[]).includes(type)) {
    flash(req, "danger", "Invalid request type.");
    return res.redirect("/requests/new");
  }
  const workerId = String(req.body.workerId ?? "");
  if (!Types.ObjectId.isValid(workerId)) {
    flash(req, "danger", "Select a worker.");
    return res.redirect(`/requests/new?type=${type}`);
  }
  const worker = await WorkerModel.findById(workerId).lean();
  if (!worker || !canUseSite(u, String(worker.siteId))) {
    flash(req, "danger", "Worker not found or outside your sites.");
    return res.redirect(`/requests/new?type=${type}`);
  }
  const remarks = String(req.body.requesterRemarks ?? "").trim() || null;

  const base: Record<string, unknown> = {
    type,
    status: "pending",
    workerId: worker._id,
    empRegNo: worker.empRegNo,
    workerName: worker.name,
    siteId: worker.siteId,
    siteName: worker.siteName,
    branchId: null,
    branchName: null,
    requestedBy: new Types.ObjectId(u.id),
    requestedByName: u.name,
    requesterRemarks: remarks,
  };
  const branch = await ProjectSiteModel.findById(worker.siteId).lean();
  if (branch) {
    const b = await BranchModel.findById(branch.branchId).lean();
    base.branchId = branch.branchId;
    base.branchName = b?.name ?? null;
  }

  if (type === "scheduled_ot") {
    const date = String(req.body.date ?? "").trim();
    const fromTime = String(req.body.fromTime ?? "").trim();
    const toTime = String(req.body.toTime ?? "").trim();
    if (!DATE_RE.test(date) || !isValidTime(fromTime) || !isValidTime(toTime)) {
      flash(req, "danger", "Enter a valid date and from/to times (HH:MM).");
      return res.redirect("/requests/new?type=scheduled_ot");
    }
    if (!endAfterStart(fromTime, toTime)) {
      flash(req, "danger", "End time must be after start time.");
      return res.redirect("/requests/new?type=scheduled_ot");
    }
    base.date = date;
    base.fromTime = fromTime;
    base.toTime = toTime;
    base.hours = round2(hmToHours(toTime) - hmToHours(fromTime));
  } else if (!remarks) {
    // Offload should carry a reason.
    flash(req, "danger", "A reason/remark is required to suggest an offload.");
    return res.redirect("/requests/new?type=offload");
  }

  await RequestModel.create(base);
  flash(req, "success", type === "scheduled_ot" ? "Overtime request submitted." : "Offload suggestion submitted.");
  res.redirect("/requests");
});

// ---- Recommend (PM) — pending → recommended ----
router.post("/requests/:id/recommend", requireCapability("recommend_request"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const r = await RequestModel.findById(req.params.id);
  if (!r || (!seesAllSites(u.role) && !canUseSite(u, String(r.siteId)))) {
    flash(req, "danger", "Request not found.");
    return res.redirect("/requests");
  }
  if (r.status !== "pending") {
    flash(req, "danger", "Only a pending request can be recommended.");
    return res.redirect("/requests");
  }
  r.status = "recommended";
  r.recommendedBy = new Types.ObjectId(u.id);
  r.recommendedByName = u.name;
  r.recommendedAt = new Date();
  r.recommenderRemarks = String(req.body.remarks ?? "").trim() || null;
  await r.save();
  flash(req, "success", "Request recommended.");
  res.redirect("/requests?tab=recommended");
});

// ---- Decide (admin) — recommended → approved | rejected ----
async function decide(req: Request, res: Response, outcome: "approved" | "rejected") {
  const u = req.currentUser!;
  const r = await RequestModel.findById(req.params.id);
  if (!r) {
    flash(req, "danger", "Request not found.");
    return res.redirect("/requests");
  }
  // HR/Management can approve or reject directly from pending; a PM
  // recommendation is optional (it adds context but is no longer a gate).
  if (!["pending", "recommended"].includes(r.status)) {
    flash(req, "danger", "This request has already been decided.");
    return res.redirect("/requests");
  }
  r.status = outcome;
  r.decidedBy = new Types.ObjectId(u.id);
  r.decidedByName = u.name;
  r.decidedAt = new Date();
  r.decisionRemarks = String(req.body.remarks ?? "").trim() || null;
  await r.save();

  // Offload approval deactivates the worker (soft); fuller soft-delete/remarks
  // plumbing arrives with the employee-lifecycle task.
  if (outcome === "approved" && r.type === "offload") {
    await WorkerModel.updateOne({ _id: r.workerId }, { $set: { status: "inactive" } });
  }
  flash(req, "success", `Request ${outcome}.`);
  res.redirect("/requests?tab=decided");
}

router.post("/requests/:id/approve", requireCapability("decide_request"), (req, res) => decide(req, res, "approved"));
router.post("/requests/:id/reject", requireCapability("decide_request"), (req, res) => decide(req, res, "rejected"));

export default router;
