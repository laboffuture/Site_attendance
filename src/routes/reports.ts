import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { config } from "../config";
import { buildXlsxBuffer, streamPdf, streamTablePdf, sendCsv } from "../lib/exporters";
import { computePayroll } from "../lib/payroll";
import { parseReportFilters, buildAttendanceQuery, groupByBranchSite, hoursBreakdown } from "../lib/report";
import { siteScopeFilter, canUseSite, workerScopeFilter } from "../lib/scope";
import { round2, siteLocalDate } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { DesignationModel } from "../models/Designation";
import { ManpowerRequestModel } from "../models/ManpowerRequest";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const TABLE_LIMIT = 2000; // rows shown in the on-screen / exported table

/** "showing first N of M" note when the table is capped (numbers stay correct). */
function capNote(matched: number): string | undefined {
  return matched > TABLE_LIMIT ? `Table capped: showing the first ${TABLE_LIMIT.toLocaleString("en-IN")} of ${matched.toLocaleString("en-IN")} rows — totals & charts cover the full set. Refine filters for a complete row list.` : undefined;
}

// ============================ Reports hub ============================
router.get("/reports", requireCapability("view_reports"), async (req: Request, res: Response) => {
  // Live headline metric per report card — cheap, scoped counts so the hub
  // reads as a status board, not a link list.
  const u = req.currentUser!;
  const aScope = siteScopeFilter(u);
  const wScope = workerScopeFilter(u);
  const today = siteLocalDate();
  const monthStart = today.slice(0, 8) + "01";
  // Payroll headline reuses computePayroll — the single source of truth — so the
  // hub tile reconciles EXACTLY with the /payroll page (per-site lunch, OT-approval
  // gate, excluded open/voided/rejected days, food). Costlier than a raw aggregate
  // but this tile is admins-only and monthly.
  const [attMonth, attToday, activeWorkers, facesReg, facesTotal, otAgg, payroll] = await Promise.all([
    AttendanceModel.countDocuments({ ...aScope, date: { $gte: monthStart } }),
    AttendanceModel.countDocuments({ ...aScope, date: today }),
    WorkerModel.countDocuments({ ...wScope, status: "active" }),
    WorkerModel.countDocuments({ ...wScope, status: { $in: ["active", "inactive"] }, "faceEncoding.0": { $exists: true } }),
    WorkerModel.countDocuments({ ...wScope, status: { $in: ["active", "inactive"] } }),
    AttendanceModel.aggregate([
      { $match: { ...aScope, "overtime.status": "pending" } },
      { $group: { _id: null, hours: { $sum: "$overtime.computedHours" }, n: { $sum: 1 } } },
    ]),
    computePayroll({ ...aScope, date: { $gte: monthStart, $lte: today } }, monthStart, today),
  ]);
  const ot = otAgg[0] ?? { hours: 0, n: 0 };
  const pay = { gross: payroll.summary.gross, workers: payroll.summary.workers };
  const reports = [
    { href: "/reports/attendance", icon: "fact_check", title: "Attendance report",
      metric: attMonth.toLocaleString("en-IN"), unit: "records this month", sub: attToday.toLocaleString("en-IN") + " logged today",
      desc: "Daily attendance, hours & overtime by branch → site." },
    { href: "/reports/employees", icon: "groups", title: "Employee report",
      metric: activeWorkers.toLocaleString("en-IN"), unit: "active employees", sub: facesReg + " / " + facesTotal + " faces enrolled",
      desc: "Headcount by designation & site, with CSV export." },
    { href: "/reports/overtime", icon: "more_time", title: "Overtime report",
      metric: round2(ot.hours).toLocaleString("en-IN"), unit: "OT hrs pending", sub: ot.n.toLocaleString("en-IN") + " records awaiting approval",
      desc: "OT hours & ₹ cost by site — pending vs approved." },
  ];
  // Payroll (money + bank details) is admins-only — hide its tile from PM/Supervisor.
  if (res.locals.can("view_payroll")) {
    reports.push({ href: "/payroll", icon: "payments", title: "Payroll report",
      metric: "₹ " + Math.round(pay.gross).toLocaleString("en-IN"), unit: "gross this month", sub: pay.workers.toLocaleString("en-IN") + " workers · normal + OT + food",
      desc: "Per-worker hours & pay (basic, OT, food, gross) with bank details — payroll-ready CSV / Excel." });
  }
  if (res.locals.can("view_manpower")) {
    const openReqs = await ManpowerRequestModel.countDocuments({ ...aScope, status: { $in: ["open", "partial"] } });
    reports.push({ href: "/manpower/allocations", icon: "engineering", title: "Allocations report",
      metric: openReqs.toLocaleString("en-IN"), unit: "open requests", sub: "manpower by site, role & date",
      desc: "Who is allocated where — manpower allocations with CSV / PDF export." });
  }
  res.render("reports/index", { title: "Reports · " + res.locals.company, active: "/reports", reports });
});

// ======================== Attendance report ========================
function reportSubtitle(f: Record<string, unknown>): string {
  const bits: string[] = [];
  if (f.dateFrom || f.dateTo) bits.push(`${f.dateFrom ?? "…"} → ${f.dateTo ?? "…"}`);
  if (f.designation) bits.push(String(f.designation));
  if (f.q) bits.push(`"${f.q}"`);
  return bits.length ? bits.join(" · ") : "All records";
}

/** Table rows (capped) + matched count + summary/charts aggregated over the FULL match. */
async function attendanceData(req: Request) {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  const query = buildAttendanceQuery(req.currentUser!, filters);
  const [tableRows, matched, facet] = await Promise.all([
    AttendanceModel.find(query).sort({ branchName: 1, siteName: 1, date: -1, workerName: 1 }).limit(TABLE_LIMIT).lean(),
    AttendanceModel.countDocuments(query),
    AttendanceModel.aggregate([
      { $match: query },
      {
        $facet: {
          byDay: [{ $group: { _id: "$date", n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
          bySite: [{ $group: { _id: "$siteName", count: { $sum: 1 }, ot: { $sum: "$overtime.computedHours" } } }, { $sort: { count: -1 } }, { $limit: 25 }],
          totals: [{ $group: { _id: null, ot: { $sum: "$overtime.computedHours" }, employees: { $addToSet: "$empRegNo" }, sites: { $addToSet: "$siteName" } } }],
        },
      },
    ]),
  ]);
  const f = facet[0] ?? { byDay: [], bySite: [], totals: [] };
  const t = f.totals[0] ?? { ot: 0, employees: [], sites: [] };
  return {
    filters, query, tableRows, matched,
    summary: { records: matched, employees: t.employees.length, otHours: round2(t.ot), sites: t.sites.length },
    reportCharts: {
      byDay: { labels: f.byDay.map((d: { _id: string }) => d._id), data: f.byDay.map((d: { n: number }) => d.n) },
      bySite: { labels: f.bySite.map((s: { _id: string }) => s._id), count: f.bySite.map((s: { count: number }) => s.count), ot: f.bySite.map((s: { ot: number }) => round2(s.ot)) },
    },
  };
}

router.get("/reports/attendance", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const { filters, tableRows, matched, summary, reportCharts } = await attendanceData(req);
  const [branches, sites, designations] = await Promise.all([
    BranchModel.find().sort({ name: 1 }).lean(),
    ProjectSiteModel.find().sort({ name: 1 }).lean(),
    DesignationModel.find().sort({ name: 1 }).lean(),
  ]);
  res.render("reports/attendance", {
    title: "Attendance report · " + res.locals.company,
    active: "/reports",
    filters,
    groups: groupByBranchSite(tableRows),
    rowCount: matched,
    shown: Math.min(matched, TABLE_LIMIT),
    capped: matched > TABLE_LIMIT,
    activeFilter: reportSubtitle(filters as Record<string, unknown>),
    branches, sites, designations, hoursBreakdown,
    reportCharts, summary,
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/reports/attendance/export.xlsx", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const { tableRows, matched } = await attendanceData(req);
  const buf = await buildXlsxBuffer(tableRows, capNote(matched));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${Date.now()}.xlsx"`);
  res.send(buf);
});

router.get("/reports/attendance/export.pdf", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const { filters, tableRows, matched } = await attendanceData(req);
  const sub = reportSubtitle(filters as Record<string, unknown>) + (capNote(matched) ? " · " + capNote(matched) : "");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${Date.now()}.pdf"`);
  streamPdf(tableRows, { title: `${res.locals.company} — Attendance Report`, subtitle: sub }, res);
});

// ========================= Employee report =========================
function employeeQuery(req: Request) {
  const siteId = String(req.query.siteId ?? "");
  const designation = String(req.query.designation ?? "");
  const status = ["active", "inactive", "pending"].includes(String(req.query.status)) ? String(req.query.status) : "";
  const q: Record<string, unknown> = { ...workerScopeFilter(req.currentUser!) };
  q.status = status || { $in: ["active", "inactive"] };
  if (siteId && Types.ObjectId.isValid(siteId) && canUseSite(req.currentUser!, siteId)) q.siteIds = new Types.ObjectId(siteId);
  if (designation) q.designationName = designation;
  return { q, filters: { siteId, designation, status } };
}

router.get("/reports/employees", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const { q, filters } = employeeQuery(req);
  const [tableRows, total, active, faceRegistered, facet, sites, designations] = await Promise.all([
    WorkerModel.find(q).select("name empRegNo designationName siteName status dailyWage").sort({ name: 1 }).limit(TABLE_LIMIT).lean(),
    WorkerModel.countDocuments(q),
    WorkerModel.countDocuments({ ...q, status: "active" }),
    WorkerModel.countDocuments({ ...q, "faceEncoding.0": { $exists: true } }),
    WorkerModel.aggregate([
      { $match: q },
      { $facet: {
        byDesignation: [{ $group: { _id: "$designationName", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }],
        bySite: [{ $group: { _id: "$siteName", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }],
      } },
    ]),
    ProjectSiteModel.find().sort({ name: 1 }).lean(),
    DesignationModel.find().sort({ name: 1 }).lean(),
  ]);
  const f = facet[0] ?? { byDesignation: [], bySite: [] };
  res.render("reports/employees", {
    title: "Employee report · " + res.locals.company,
    active: "/reports",
    workers: tableRows, sites, designations, filters,
    rowCount: total, capped: total > TABLE_LIMIT, shown: Math.min(total, TABLE_LIMIT),
    summary: { total, active, faceRegistered, facePending: Math.max(0, total - faceRegistered) },
    charts: {
      byDesignation: { labels: f.byDesignation.map((d: { _id: string }) => d._id), data: f.byDesignation.map((d: { n: number }) => d.n) },
      bySite: { labels: f.bySite.map((s: { _id: string }) => s._id), data: f.bySite.map((s: { n: number }) => s.n) },
    },
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/reports/employees/export.csv", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const { q } = employeeQuery(req);
  const [rows, total] = await Promise.all([
    WorkerModel.find(q).select("name empRegNo designationName siteName status dailyWage").sort({ name: 1 }).limit(TABLE_LIMIT).lean(),
    WorkerModel.countDocuments(q),
  ]);
  sendCsv(res, `employees-${Date.now()}.csv`,
    ["Employee ID", "Name", "Designation", "Site", "Status", "Daily wage"],
    rows.map((w) => [w.empRegNo, w.name, w.designationName, w.siteName, w.status, w.dailyWage ?? ""]),
    capNote(total));
});

router.get("/reports/employees/export.pdf", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const { q } = employeeQuery(req);
  const rows = await WorkerModel.find(q).select("name empRegNo designationName siteName status dailyWage").sort({ name: 1 }).limit(TABLE_LIMIT).lean();
  const cols = [
    { header: "Emp ID", key: "empRegNo", pdf: 90 },
    { header: "Name", key: "name", pdf: 150 },
    { header: "Designation", key: "designationName", pdf: 120 },
    { header: "Site", key: "siteName", pdf: 150 },
    { header: "Status", key: "status", pdf: 70 },
    { header: "Daily Wage", key: "dailyWage", pdf: 80 },
  ];
  const flat = rows.map((w) => ({ empRegNo: String(w.empRegNo ?? ""), name: String(w.name ?? ""), designationName: String(w.designationName ?? ""), siteName: String(w.siteName ?? ""), status: String(w.status ?? ""), dailyWage: w.dailyWage ?? "" }));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="employees-${Date.now()}.pdf"`);
  streamTablePdf(flat, cols, { title: `${res.locals.company} — Employee Report`, subtitle: `${flat.length} employees` }, res);
});

// ========================= Overtime report =========================
function overtimePipeline(req: Request) {
  const dateFrom = String(req.query.dateFrom ?? "");
  const dateTo = String(req.query.dateTo ?? "");
  const siteId = String(req.query.siteId ?? "");
  const match: Record<string, unknown> = { ...siteScopeFilter(req.currentUser!), "overtime.status": { $in: ["pending", "approved"] } };
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    const range: Record<string, string> = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) range.$gte = dateFrom;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) range.$lte = dateTo;
    match.date = range;
  }
  if (siteId && Types.ObjectId.isValid(siteId) && canUseSite(req.currentUser!, siteId)) match.siteId = new Types.ObjectId(siteId);
  return { match, filters: { dateFrom, dateTo, siteId } };
}

async function overtimeData(req: Request) {
  const { match, filters } = overtimePipeline(req);
  const grouped = await AttendanceModel.aggregate([
    { $match: match },
    { $lookup: { from: "workers", localField: "workerId", foreignField: "_id", as: "w" } },
    { $addFields: {
      wage: { $arrayElemAt: ["$w.dailyWage", 0] },
      otH: { $cond: [{ $eq: ["$overtime.status", "approved"] }, { $ifNull: ["$overtime.approvedHours", "$overtime.computedHours"] }, "$overtime.computedHours"] },
    } },
    { $addFields: { hasWage: { $cond: [{ $and: [{ $ne: ["$wage", null] }, { $gt: ["$standardHours", 0] }] }, 1, 0] } } },
    { $addFields: { cost: { $cond: ["$hasWage", { $multiply: ["$otH", { $divide: ["$wage", "$standardHours"] }, config.otMultiplier] }, 0] } } },
    { $group: {
      _id: "$siteName",
      pending: { $sum: { $cond: [{ $eq: ["$overtime.status", "pending"] }, "$otH", 0] } },
      approved: { $sum: { $cond: [{ $eq: ["$overtime.status", "approved"] }, "$otH", 0] } },
      cost: { $sum: "$cost" },
      otHoursTotal: { $sum: "$otH" },
      withWageHours: { $sum: { $cond: ["$hasWage", "$otH", 0] } },
      missingWage: { $sum: { $cond: ["$hasWage", 0, 1] } },
    } },
    { $sort: { otHoursTotal: -1 } },
  ]);
  const groups = grouped.map((g) => ({ site: g._id ?? "—", pending: round2(g.pending), approved: round2(g.approved), cost: Math.round(g.cost) }));
  const totalOt = grouped.reduce((a, g) => a + g.otHoursTotal, 0);
  const withWage = grouped.reduce((a, g) => a + g.withWageHours, 0);
  const summary = {
    pendingHours: round2(groups.reduce((a, g) => a + g.pending, 0)),
    approvedHours: round2(groups.reduce((a, g) => a + g.approved, 0)),
    cost: groups.reduce((a, g) => a + g.cost, 0),
    sites: groups.length,
    missingWage: grouped.reduce((a, g) => a + g.missingWage, 0),
    wageCoverage: totalOt > 0 ? Math.round((withWage / totalOt) * 100) : 100,
  };
  return { groups, summary, filters };
}

/** Date+time in IST for the approval log (e.g. "25 Jun 2026, 18:30"). */
function fmtDT(d: unknown): string {
  return d ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(d as string)) : "—";
}

/** Per-record APPROVED overtime — who approved it and exactly when (newest first). */
async function approvedOtData(req: Request) {
  const { match } = overtimePipeline(req);
  const rows = await AttendanceModel.aggregate([
    { $match: { ...match, "overtime.status": "approved" } },
    { $lookup: { from: "users", localField: "overtime.approvedBy", foreignField: "_id", as: "appr" } },
    { $project: {
      workerName: 1, empRegNo: 1, siteName: 1, date: 1,
      otHours: { $round: [{ $ifNull: ["$overtime.approvedHours", "$overtime.computedHours"] }, 2] },
      approvedByName: { $ifNull: [{ $arrayElemAt: ["$appr.name", 0] }, null] },
      approvedAt: "$overtime.approvedAt",
    } },
    { $sort: { approvedAt: -1 } },
    { $limit: 1000 },
  ]);
  return rows as { workerName: string; empRegNo: string; siteName: string; date: string; otHours: number; approvedByName: string | null; approvedAt: Date | null }[];
}

router.get("/reports/overtime", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const [{ groups, summary, filters }, approvedRows] = await Promise.all([overtimeData(req), approvedOtData(req)]);
  const sites = await ProjectSiteModel.find().sort({ name: 1 }).lean();
  res.render("reports/overtime", {
    title: "Overtime report · " + res.locals.company,
    active: "/reports",
    groups, summary, filters, sites,
    otMultiplier: config.otMultiplier,
    charts: { labels: groups.map((g) => g.site), pending: groups.map((g) => g.pending), approved: groups.map((g) => g.approved) },
    approved: approvedRows.map((a) => ({ workerName: a.workerName, empRegNo: a.empRegNo, siteName: a.siteName, date: a.date, otHours: a.otHours, approvedByName: a.approvedByName ?? "—", approvedOn: fmtDT(a.approvedAt) })),
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/reports/overtime/export.csv", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const { groups } = await overtimeData(req);
  sendCsv(res, `overtime-${Date.now()}.csv`,
    ["Site", "Pending OT hours", "Approved OT hours", "OT cost (INR)"],
    groups.map((g) => [g.site, g.pending, g.approved, g.cost]));
});

// Approved-OT log exports (who approved + exact time).
router.get("/reports/overtime/approved.csv", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const rows = await approvedOtData(req);
  sendCsv(res, `approved-ot-${Date.now()}.csv`,
    ["Worker", "Emp ID", "Site", "Date", "OT hours", "Approved by", "Approved on (IST)"],
    rows.map((r) => [r.workerName, r.empRegNo, r.siteName, r.date, r.otHours, r.approvedByName ?? "—", fmtDT(r.approvedAt)]));
});

router.get("/reports/overtime/approved.pdf", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const rows = await approvedOtData(req);
  const cols = [
    { header: "Worker", key: "workerName", pdf: 116 }, { header: "Emp ID", key: "empRegNo", pdf: 78 },
    { header: "Site", key: "siteName", pdf: 104 }, { header: "Date", key: "date", pdf: 64 },
    { header: "OT h", key: "otHours", pdf: 40 }, { header: "Approved by", key: "approvedByName", pdf: 104 },
    { header: "Approved on (IST)", key: "approvedOn", pdf: 140 },
  ];
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="approved-ot-${Date.now()}.pdf"`);
  streamTablePdf(rows.map((r) => ({ workerName: r.workerName, empRegNo: r.empRegNo, siteName: r.siteName, date: r.date, otHours: r.otHours, approvedByName: r.approvedByName ?? "—", approvedOn: fmtDT(r.approvedAt) })), cols, { title: `${res.locals.company} — Approved OT log`, subtitle: `${rows.length} approved OT entries` }, res);
});

router.get("/reports/overtime/export.pdf", requireCapability("view_reports"), async (req: Request, res: Response) => {
  const { groups } = await overtimeData(req);
  const cols = [
    { header: "Site", key: "site", pdf: 240 },
    { header: "Pending OT (h)", key: "pending", pdf: 120 },
    { header: "Approved OT (h)", key: "approved", pdf: 120 },
    { header: "OT Cost (Rs)", key: "cost", pdf: 140 },
  ];
  const flat = groups.map((g) => ({ site: String(g.site ?? ""), pending: g.pending, approved: g.approved, cost: g.cost }));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="overtime-${Date.now()}.pdf"`);
  streamTablePdf(flat, cols, { title: `${res.locals.company} — Overtime Report`, subtitle: "OT hours & cost by site" }, res);
});

// Payroll is its own first-class module — see src/routes/payroll.ts (/payroll).

export default router;
