import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { sendCsv, streamTablePdf } from "../lib/exporters";
import { nextCode, computeStatus } from "../lib/manpower";
import { ymd } from "../lib/payroll";
import { siteScopeFilter, canUseSite } from "../lib/scope";
import { siteLocalDate } from "../lib/time";
import { BranchModel } from "../models/Branch";
import { DesignationModel } from "../models/Designation";
import { ManpowerRequestModel } from "../models/ManpowerRequest";
import { OutsourceEmployeeModel } from "../models/OutsourceEmployee";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function flash(req: Request, type: "success" | "danger", text: string): void { req.session.flash = { type, text }; }

// ======================= List (scoped + status tab) =======================
router.get("/manpower", requireCapability("view_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const scope = siteScopeFilter(u);
  const tab = ["open", "partial", "fulfilled", "cancelled", "all"].includes(String(req.query.tab)) ? String(req.query.tab) : "open";
  const query: Record<string, unknown> = { ...scope };
  if (tab !== "all") query.status = tab;
  const [requests, countAgg] = await Promise.all([
    ManpowerRequestModel.find(query).sort({ createdAt: -1 }).limit(500).lean(),
    ManpowerRequestModel.aggregate([{ $match: { ...scope } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const byStatus = new Map<string, number>(countAgg.map((c) => [c._id as string, c.n as number]));
  res.render("manpower/index", {
    title: "Allocate Manpower · " + res.locals.company, active: "/manpower", tab,
    requests: requests.map((r) => ({
      ...r, id: String(r._id),
      needed: r.lines.reduce((a: number, l: { qty: number }) => a + l.qty, 0),
      filled: r.allocations.length,
    })),
    counts: { open: byStatus.get("open") ?? 0, partial: byStatus.get("partial") ?? 0, fulfilled: byStatus.get("fulfilled") ?? 0, cancelled: byStatus.get("cancelled") ?? 0 },
    canRequest: res.locals.can("request_manpower"),
    canAllocate: res.locals.can("allocate_manpower"),
  });
});

// ======================= New request form =======================
router.get("/manpower/new", requireCapability("request_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const [sites, designations] = await Promise.all([
    ProjectSiteModel.find({ ...siteScopeFilter(u), status: "active" }).sort({ name: 1 }).select("name").lean(),
    DesignationModel.find().sort({ name: 1 }).lean(),
  ]);
  res.render("manpower/new", { title: "New manpower request · " + res.locals.company, active: "/manpower", sites, designations });
});

// ======================= Calendar board (literal — before /:id) =======================
router.get("/manpower/board", requireCapability("view_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const sites = await ProjectSiteModel.find({ ...siteScopeFilter(u), status: "active" }).sort({ name: 1 }).select("name").lean();
  const siteId = String(req.query.siteId ?? (sites[0] ? String(sites[0]._id) : ""));
  const baseRender = { title: "Manpower board · " + res.locals.company, active: "/manpower", sites };
  if (!siteId || !Types.ObjectId.isValid(siteId) || !canUseSite(u, siteId)) {
    return res.render("manpower/board", { ...baseRender, siteId: "", days: [], rows: [], from: "", to: "" });
  }
  const todayStr = siteLocalDate();
  const from = DATE_RE.test(String(req.query.from)) ? String(req.query.from) : todayStr;
  const toDefault = new Date(from + "T00:00:00"); toDefault.setDate(toDefault.getDate() + 6);
  const to = DATE_RE.test(String(req.query.to)) ? String(req.query.to) : ymd(toDefault);
  const days: string[] = [];
  for (let d = new Date(from + "T00:00:00"), end = new Date(to + "T00:00:00"); d <= end; d.setDate(d.getDate() + 1)) days.push(ymd(d));
  const reqs = await ManpowerRequestModel.find({ siteId, status: { $ne: "cancelled" }, dateFrom: { $lte: to }, dateTo: { $gte: from } }).lean();
  const rows = reqs.flatMap((r) => r.lines.map((l) => ({
    reqId: String(r._id), reqCode: r.reqCode, role: l.designationName, qty: l.qty,
    filled: r.allocations.filter((a) => String(a.lineDesignationId) === String(l.designationId)).length,
    spanFrom: r.dateFrom, spanTo: r.dateTo,
  })));
  res.render("manpower/board", { ...baseRender, siteId, from, to, days, rows });
});

// ======================= Outsource employees (literal — before /:id) =======================
router.get("/manpower/outsource", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const [people, designations] = await Promise.all([
    OutsourceEmployeeModel.find().sort({ active: -1, name: 1 }).lean(),
    DesignationModel.find().sort({ name: 1 }).lean(),
  ]);
  res.render("manpower/outsource", { title: "Outsource employees · " + res.locals.company, active: "/manpower", people, designations });
});

router.post("/manpower/outsource", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) { flash(req, "danger", "Name is required."); return res.redirect("/manpower/outsource"); }
  const designationId = Types.ObjectId.isValid(String(req.body.designationId)) ? new Types.ObjectId(String(req.body.designationId)) : null;
  const desig = designationId ? await DesignationModel.findById(designationId).lean() : null;
  const code = await nextCode("OUT", "outsourceEmp", 4);
  await OutsourceEmployeeModel.create({
    code, name, designationId, designationName: desig?.name ?? null,
    outsourceCompany: String(req.body.outsourceCompany ?? "").trim() || null,
    payRate: Number(req.body.payRate) || null, phone: String(req.body.phone ?? "").trim() || null, active: true,
  });
  flash(req, "success", `Added ${name} (${code}).`);
  res.redirect("/manpower/outsource");
});

router.post("/manpower/outsource/:id", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const o = await OutsourceEmployeeModel.findById(req.params.id);
  if (!o) { flash(req, "danger", "Not found."); return res.redirect("/manpower/outsource"); }
  if (String(req.body.action) === "toggle") o.active = !o.active;
  else {
    o.name = String(req.body.name ?? o.name).trim() || o.name;
    o.outsourceCompany = String(req.body.outsourceCompany ?? "").trim() || null;
    o.payRate = Number(req.body.payRate) || null;
    o.phone = String(req.body.phone ?? "").trim() || null;
  }
  await o.save();
  flash(req, "success", "Saved.");
  res.redirect("/manpower/outsource");
});

// ======================= Allocations report (literal — before /:id) =======================
router.get("/manpower/allocations", requireCapability("view_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const reqs = await ManpowerRequestModel.find({ ...siteScopeFilter(u), status: { $ne: "cancelled" } }).sort({ createdAt: -1 }).limit(2000).lean();
  const rows = reqs.flatMap((r) => r.allocations.map((a) => ({
    reqCode: r.reqCode, site: r.siteName, shift: r.shiftType, dateFrom: r.dateFrom, dateTo: r.dateTo,
    role: a.designationName ?? "", kind: a.kind, name: a.name, code: a.code ?? "", allocatedByName: a.allocatedByName ?? "",
  })));
  const format = String(req.query.format ?? "");
  if (format === "csv") {
    sendCsv(res, `allocations-${Date.now()}.csv`,
      ["Req", "Site", "Shift", "From", "To", "Role", "Type", "Name", "Code", "Allocated by"],
      rows.map((x) => [x.reqCode, x.site, x.shift, x.dateFrom, x.dateTo, x.role, x.kind, x.name, x.code, x.allocatedByName]));
    return;
  }
  if (format === "pdf") {
    const cols = [
      { header: "Req", key: "reqCode", pdf: 78 }, { header: "Site", key: "site", pdf: 110 }, { header: "Shift", key: "shift", pdf: 50 },
      { header: "From", key: "dateFrom", pdf: 64 }, { header: "To", key: "dateTo", pdf: 64 }, { header: "Role", key: "role", pdf: 90 },
      { header: "Type", key: "kind", pdf: 54 }, { header: "Name", key: "name", pdf: 120 }, { header: "Code", key: "code", pdf: 70 }, { header: "By", key: "allocatedByName", pdf: 80 },
    ];
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="allocations-${Date.now()}.pdf"`);
    streamTablePdf(rows.map((x) => ({ ...x })), cols, { title: `${res.locals.company} — Allocations`, subtitle: `${rows.length} allocations` }, res);
    return;
  }
  res.render("manpower/report", {
    title: "Allocations report · " + res.locals.company, active: "/manpower", rows,
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

// ======================= Create request =======================
router.post("/manpower", requireCapability("request_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const siteId = String(req.body.siteId ?? "");
  const shiftType = ["day", "night", "sunday"].includes(String(req.body.shiftType)) ? String(req.body.shiftType) : "day";
  const dateFrom = String(req.body.dateFrom ?? "").trim();
  const dateTo = String(req.body.dateTo ?? "").trim();
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(u, siteId) || !DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo) || dateFrom > dateTo) {
    flash(req, "danger", "Pick a site in your scope and a valid date range.");
    return res.redirect("/manpower/new");
  }
  const ids = ([] as string[]).concat(req.body.lineDesignationId ?? []);
  const qtys = ([] as string[]).concat(req.body.lineQty ?? []);
  const desigs = await DesignationModel.find({ _id: { $in: ids.filter((x) => Types.ObjectId.isValid(x)) } }).lean();
  const dmap = new Map(desigs.map((d) => [String(d._id), d.name]));
  const lines = ids
    .map((id, i) => ({ id, qty: Math.max(0, Number(qtys[i]) || 0) }))
    .filter((l) => Types.ObjectId.isValid(l.id) && l.qty > 0 && dmap.has(l.id))
    .map((l) => ({ designationId: new Types.ObjectId(l.id), designationName: dmap.get(l.id)!, qty: l.qty }));
  if (!lines.length) { flash(req, "danger", "Add at least one role with a quantity."); return res.redirect("/manpower/new"); }

  const site = await ProjectSiteModel.findById(siteId).lean();
  const branch = site ? await BranchModel.findById(site.branchId).lean() : null;
  const reqCode = await nextCode("MPA", "manpowerReq");
  await ManpowerRequestModel.create({
    reqCode, siteId: site!._id, siteName: site!.name, branchId: site!.branchId, branchName: branch?.name ?? null,
    shiftType, dateFrom, dateTo, lines, allocations: [], status: "open",
    requestedBy: new Types.ObjectId(u.id), requestedByName: u.name, requestedAt: new Date(),
    requesterRemarks: String(req.body.requesterRemarks ?? "").trim() || null,
  });
  flash(req, "success", `Request ${reqCode} created.`);
  res.redirect("/manpower");
});

// ======================= Detail (/:id — after all literal GETs) =======================
router.get("/manpower/:id", requireCapability("view_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  if (!Types.ObjectId.isValid(req.params.id)) { flash(req, "danger", "Request not found."); return res.redirect("/manpower"); }
  const r = await ManpowerRequestModel.findById(req.params.id).lean();
  if (!r || !canUseSite(u, String(r.siteId))) { flash(req, "danger", "Request not found or out of scope."); return res.redirect("/manpower"); }
  const lines = r.lines.map((l) => ({
    designationId: String(l.designationId), designationName: l.designationName, qty: l.qty,
    filled: r.allocations.filter((a) => String(a.lineDesignationId) === String(l.designationId)).length,
  }));
  const canAllocate = res.locals.can("allocate_manpower");
  let workers: { id: string; name: string; empRegNo: string; designationId: string; designationName: string }[] = [];
  let outsource: { id: string; name: string; code: string }[] = [];
  if (canAllocate) {
    const [ws, os] = await Promise.all([
      WorkerModel.find({ status: "active" }).select("name empRegNo designationId designationName").sort({ name: 1 }).lean(),
      OutsourceEmployeeModel.find({ active: true }).select("name code").sort({ name: 1 }).lean(),
    ]);
    workers = ws.map((w) => ({ id: String(w._id), name: w.name, empRegNo: w.empRegNo, designationId: String(w.designationId), designationName: w.designationName }));
    outsource = os.map((o) => ({ id: String(o._id), name: o.name, code: o.code }));
  }
  res.render("manpower/detail", {
    title: r.reqCode + " · " + res.locals.company, active: "/manpower",
    r: { ...r, id: String(r._id), allocations: r.allocations.map((a) => ({ ...a, refId: String(a.refId), lineDesignationId: String(a.lineDesignationId) })) },
    lines, canAllocate, workers, outsource,
  });
});

// ======================= Allocate / deallocate / cancel =======================
async function loadOwned(req: Request, res: Response) {
  const u = req.currentUser!;
  if (!Types.ObjectId.isValid(req.params.id)) { flash(req, "danger", "Request not found."); res.redirect("/manpower"); return null; }
  const r = await ManpowerRequestModel.findById(req.params.id);
  if (!r || !canUseSite(u, String(r.siteId))) { flash(req, "danger", "Request not found or out of scope."); res.redirect("/manpower"); return null; }
  return r;
}

router.post("/manpower/:id/allocate", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const r = await loadOwned(req, res); if (!r) return;
  if (r.status === "cancelled") { flash(req, "danger", "Request is cancelled."); return res.redirect(`/manpower/${r._id}`); }
  const u = req.currentUser!;
  const lineDesignationId = String(req.body.lineDesignationId ?? "");
  const kind = String(req.body.kind ?? "");
  const refId = String(req.body.refId ?? "");
  const line = r.lines.find((l) => String(l.designationId) === lineDesignationId);
  if (!line || !["worker", "outsource"].includes(kind) || !Types.ObjectId.isValid(refId)) {
    flash(req, "danger", "Pick a role line and a person."); return res.redirect(`/manpower/${r._id}`);
  }
  if (r.allocations.some((a) => String(a.refId) === refId && String(a.lineDesignationId) === lineDesignationId)) {
    flash(req, "danger", "Already allocated to this role."); return res.redirect(`/manpower/${r._id}`);
  }
  if (kind === "worker") {
    const w = await WorkerModel.findById(refId).lean();
    if (!w) { flash(req, "danger", "Worker not found."); return res.redirect(`/manpower/${r._id}`); }
    r.allocations.push({ kind: "worker", refId: w._id, code: w.empRegNo, name: w.name, lineDesignationId: line.designationId, designationName: line.designationName, allocatedBy: new Types.ObjectId(u.id), allocatedByName: u.name, allocatedAt: new Date() });
    await WorkerModel.updateOne({ _id: w._id }, { $addToSet: { siteIds: r.siteId } }); // can now scan at this site
  } else {
    const o = await OutsourceEmployeeModel.findById(refId).lean();
    if (!o) { flash(req, "danger", "Outsource person not found."); return res.redirect(`/manpower/${r._id}`); }
    r.allocations.push({ kind: "outsource", refId: o._id, code: o.code, name: o.name, lineDesignationId: line.designationId, designationName: line.designationName, allocatedBy: new Types.ObjectId(u.id), allocatedByName: u.name, allocatedAt: new Date() });
  }
  r.status = computeStatus(r);
  await r.save();
  flash(req, "success", "Allocated.");
  res.redirect(`/manpower/${r._id}`);
});

router.post("/manpower/:id/deallocate", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const r = await loadOwned(req, res); if (!r) return;
  const refId = String(req.body.refId ?? "");
  const lineDesignationId = String(req.body.lineDesignationId ?? "");
  r.allocations = r.allocations.filter((a) => !(String(a.refId) === refId && String(a.lineDesignationId) === lineDesignationId)) as typeof r.allocations;
  r.status = computeStatus(r);
  await r.save();
  flash(req, "success", "Allocation removed.");
  res.redirect(`/manpower/${r._id}`);
});

router.post("/manpower/:id/cancel", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const r = await loadOwned(req, res); if (!r) return;
  r.status = "cancelled";
  await r.save();
  flash(req, "success", "Request cancelled.");
  res.redirect(`/manpower/${r._id}`);
});

export default router;
