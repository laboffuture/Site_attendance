import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { config } from "../config";
import { buildXlsxBuffer, buildPayrollXlsx, streamPdf } from "../lib/exporters";
import { parseReportFilters, buildAttendanceQuery, groupByBranchSite, hoursBreakdown } from "../lib/report";
import { siteScopeFilter, canUseSite, workerScopeFilter } from "../lib/scope";
import { round2, siteLocalDate } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { DesignationModel } from "../models/Designation";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const TABLE_LIMIT = 2000; // rows shown in the on-screen / exported table

function sendCsv(res: Response, filename: string, headers: string[], rows: (string | number | null)[][], note?: string): void {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [headers, ...rows].map((r) => r.map(esc).join(","));
  if (note) lines.push("", esc(note));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(lines.join("\n"));
}

/** "showing first N of M" note when the table is capped (numbers stay correct). */
function capNote(matched: number): string | undefined {
  return matched > TABLE_LIMIT ? `Table capped: showing the first ${TABLE_LIMIT.toLocaleString("en-IN")} of ${matched.toLocaleString("en-IN")} rows — totals & charts cover the full set. Refine filters for a complete row list.` : undefined;
}

// ============================ Reports hub ============================
router.get("/reports", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  // Live headline metric per report card — cheap, scoped counts so the hub
  // reads as a status board, not a link list.
  const u = req.currentUser!;
  const aScope = siteScopeFilter(u);
  const wScope = workerScopeFilter(u);
  const today = siteLocalDate();
  const monthStart = today.slice(0, 8) + "01";
  const STD = config.payrollStandardHours;
  const [attMonth, attToday, activeWorkers, facesReg, facesTotal, otAgg, payAgg] = await Promise.all([
    AttendanceModel.countDocuments({ ...aScope, date: { $gte: monthStart } }),
    AttendanceModel.countDocuments({ ...aScope, date: today }),
    WorkerModel.countDocuments({ ...wScope, status: "active" }),
    WorkerModel.countDocuments({ ...wScope, status: { $in: ["active", "inactive"] }, "faceEncoding.0": { $exists: true } }),
    WorkerModel.countDocuments({ ...wScope, status: { $in: ["active", "inactive"] } }),
    AttendanceModel.aggregate([
      { $match: { ...aScope, "overtime.status": "pending" } },
      { $group: { _id: null, hours: { $sum: "$overtime.computedHours" }, n: { $sum: 1 } } },
    ]),
    AttendanceModel.aggregate([
      { $match: { ...aScope, date: { $gte: monthStart } } },
      { $lookup: { from: "workers", localField: "workerId", foreignField: "_id", as: "w" } },
      { $addFields: { wage: { $ifNull: [{ $arrayElemAt: ["$w.dailyWage", 0] }, 0] }, foodApp: { $arrayElemAt: ["$w.foodAllowance.applicable", 0] }, foodAmt: { $ifNull: [{ $arrayElemAt: ["$w.foodAllowance.amount", 0] }, 0] }, tot: { $ifNull: ["$totalHours", 0] } } },
      { $addFields: { normal: { $min: ["$tot", STD] }, ot: { $max: [0, { $subtract: ["$tot", STD] }] } } },
      { $group: { _id: null, gross: { $sum: { $add: [
        { $multiply: ["$normal", { $divide: ["$wage", STD] }] },
        { $multiply: ["$ot", { $divide: ["$wage", STD] }, config.otMultiplier] },
        { $cond: [{ $and: [{ $eq: ["$foodApp", true] }, { $gte: ["$tot", 5] }] }, "$foodAmt", 0] },
      ] } }, workers: { $addToSet: "$workerId" } } },
    ]),
  ]);
  const ot = otAgg[0] ?? { hours: 0, n: 0 };
  const pay = payAgg[0] ?? { gross: 0, workers: [] };
  res.render("reports/index", {
    title: "Reports · " + res.locals.company,
    active: "/reports",
    reports: [
      { href: "/reports/attendance", icon: "fact_check", title: "Attendance report",
        metric: attMonth.toLocaleString("en-IN"), unit: "records this month", sub: attToday.toLocaleString("en-IN") + " logged today",
        desc: "Daily attendance, hours & overtime by branch → site." },
      { href: "/reports/employees", icon: "groups", title: "Employee report",
        metric: activeWorkers.toLocaleString("en-IN"), unit: "active employees", sub: facesReg + " / " + facesTotal + " faces enrolled",
        desc: "Headcount by designation & site, with CSV export." },
      { href: "/reports/overtime", icon: "more_time", title: "Overtime report",
        metric: round2(ot.hours).toLocaleString("en-IN"), unit: "OT hrs pending", sub: ot.n.toLocaleString("en-IN") + " records awaiting approval",
        desc: "OT hours & ₹ cost by site — pending vs approved." },
      { href: "/reports/payroll", icon: "payments", title: "Payroll report",
        metric: "₹ " + Math.round(pay.gross).toLocaleString("en-IN"), unit: "gross this month", sub: (pay.workers ? pay.workers.length : 0).toLocaleString("en-IN") + " workers · normal + OT + food",
        desc: "Per-worker hours & pay (basic, OT, food, gross) with bank details — payroll-ready CSV / Excel." },
    ],
  });
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

router.get("/reports/attendance", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
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

router.get("/reports/attendance/export.xlsx", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { tableRows, matched } = await attendanceData(req);
  const buf = await buildXlsxBuffer(tableRows, capNote(matched));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${Date.now()}.xlsx"`);
  res.send(buf);
});

router.get("/reports/attendance/export.pdf", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
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

router.get("/reports/employees", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
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

router.get("/reports/employees/export.csv", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
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

router.get("/reports/overtime", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { groups, summary, filters } = await overtimeData(req);
  const sites = await ProjectSiteModel.find().sort({ name: 1 }).lean();
  res.render("reports/overtime", {
    title: "Overtime report · " + res.locals.company,
    active: "/reports",
    groups, summary, filters, sites,
    otMultiplier: config.otMultiplier,
    charts: { labels: groups.map((g) => g.site), pending: groups.map((g) => g.pending), approved: groups.map((g) => g.approved) },
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/reports/overtime/export.csv", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { groups } = await overtimeData(req);
  sendCsv(res, `overtime-${Date.now()}.csv`,
    ["Site", "Pending OT hours", "Approved OT hours", "OT cost (INR)"],
    groups.map((g) => [g.site, g.pending, g.approved, g.cost]));
});

// ========================= Payroll report =========================
// Per-worker hours + pay over a period, matching the client OT sheet:
//   normal = min(day total, standardDay) summed; OT = beyond standardDay summed;
//   hourly = BASIC / standardDay; OT paid at config.otMultiplier (×1 per the sheet);
//   food paid on days worked >= 5h; gross = normal pay + OT pay + food.
async function payrollData(req: Request) {
  const u = req.currentUser!;
  const today = siteLocalDate();
  const monthStart = today.slice(0, 8) + "01";
  const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom ?? "")) ? String(req.query.dateFrom) : monthStart;
  const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo ?? "")) ? String(req.query.dateTo) : today;
  const siteId = String(req.query.siteId ?? "");
  const STD = config.payrollStandardHours;
  const match: Record<string, unknown> = { ...siteScopeFilter(u), date: { $gte: dateFrom, $lte: dateTo } };
  if (siteId && Types.ObjectId.isValid(siteId) && canUseSite(u, siteId)) match.siteId = new Types.ObjectId(siteId);

  const rows = await AttendanceModel.aggregate([
    { $match: match },
    { $group: {
      _id: "$workerId",
      empRegNo: { $first: "$empRegNo" }, name: { $first: "$workerName" }, designation: { $first: "$designationName" }, siteName: { $first: "$siteName" },
      normalHrs: { $sum: { $min: [{ $ifNull: ["$totalHours", 0] }, STD] } },
      otHrs: { $sum: { $max: [0, { $subtract: [{ $ifNull: ["$totalHours", 0] }, STD] }] } },
      foodDays: { $sum: { $cond: [{ $gte: [{ $ifNull: ["$totalHours", 0] }, 5] }, 1, 0] } },
      days: { $sum: 1 },
    } },
    { $lookup: { from: "workers", localField: "_id", foreignField: "_id", as: "w" } },
    { $addFields: { w: { $arrayElemAt: ["$w", 0] } } },
    { $sort: { name: 1 } },
  ]);

  const mult = config.otMultiplier;
  const workers = rows.map((r) => {
    const wage: number | null = r.w?.dailyWage ?? null;
    const foodApplicable = !!r.w?.foodAllowance?.applicable;
    const foodRate = foodApplicable ? (r.w?.foodAllowance?.amount ?? 0) : 0;
    const hourly = wage != null ? wage / STD : 0;
    const normalPay = Math.round(r.normalHrs * hourly);
    const otPay = Math.round(r.otHrs * hourly * mult);
    const foodAllowance = Math.round(foodRate * r.foodDays);
    return {
      empRegNo: r.empRegNo, name: r.name, designation: r.designation, siteName: r.siteName,
      account: r.w?.bank?.accountNumber ?? "", ifsc: r.w?.bank?.ifsc ?? "",
      basic: wage, food: foodRate,
      days: r.days, normalHrs: round2(r.normalHrs), otHrs: round2(r.otHrs), foodDays: r.foodDays,
      normalPay, otPay, foodAllowance, gross: normalPay + otPay + foodAllowance, hasWage: wage != null,
    };
  });
  const summary = {
    workers: workers.length,
    normalHrs: round2(workers.reduce((a, w) => a + w.normalHrs, 0)),
    otHrs: round2(workers.reduce((a, w) => a + w.otHrs, 0)),
    gross: workers.reduce((a, w) => a + w.gross, 0),
    missingWage: workers.filter((w) => !w.hasWage).length,
  };
  return { workers, summary, filters: { dateFrom, dateTo, siteId }, std: STD };
}

router.get("/reports/payroll", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, summary, filters, std } = await payrollData(req);
  const sites = await ProjectSiteModel.find().sort({ name: 1 }).lean();
  res.render("reports/payroll", {
    title: "Payroll report · " + res.locals.company,
    active: "/reports",
    workers, summary, filters, sites, std,
    otMultiplier: config.otMultiplier,
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/reports/payroll/export.csv", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, filters } = await payrollData(req);
  sendCsv(res, `payroll-${filters.dateFrom}_to_${filters.dateTo}.csv`,
    ["S.No", "Emp Code", "Worker", "Designation", "Account No", "IFSC", "Basic", "Food", "Days", "Normal Hrs", "OT Hrs", "Normal Pay", "OT Pay", "Food Count", "Food Allowance", "Total Pay"],
    workers.map((w, i) => [i + 1, w.empRegNo, w.name, w.designation, w.account, w.ifsc, w.basic ?? "", w.food, w.days, w.normalHrs, w.otHrs, w.normalPay, w.otPay, w.foodDays, w.foodAllowance, w.gross]));
});

router.get("/reports/payroll/export.xlsx", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, filters } = await payrollData(req);
  const buf = await buildPayrollXlsx(workers, `${filters.dateFrom} → ${filters.dateTo}`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="payroll-${filters.dateFrom}_to_${filters.dateTo}.xlsx"`);
  res.send(buf);
});

export default router;
