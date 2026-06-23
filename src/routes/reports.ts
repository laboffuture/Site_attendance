import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { config } from "../config";
import { buildXlsxBuffer, streamPdf } from "../lib/exporters";
import { parseReportFilters, buildAttendanceQuery, groupByBranchSite, hoursBreakdown } from "../lib/report";
import { siteScopeFilter, workerScopeFilter } from "../lib/scope";
import { round2 } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { DesignationModel } from "../models/Designation";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const MAX_ROWS = 5000;

function sendCsv(res: Response, filename: string, headers: string[], rows: (string | number | null)[][]): void {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const body = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(body);
}

// ============================ Reports hub ============================
router.get("/reports", requireCapability("view_dashboard"), async (_req: Request, res: Response) => {
  res.render("reports/index", {
    title: "Reports · " + res.locals.company,
    active: "/reports",
    reports: [
      { href: "/reports/attendance", icon: "fact_check", title: "Attendance report", desc: "Daily attendance, hours & overtime by branch → site, with Excel / PDF export." },
      { href: "/reports/employees", icon: "groups", title: "Employee report", desc: "Workforce headcount by designation & site, face enrolment, with CSV export." },
      { href: "/reports/overtime", icon: "more_time", title: "Overtime report", desc: "Overtime hours and ₹ cost by site — pending vs approved." },
    ],
  });
});

// ======================== Attendance report ========================
async function fetchRows(req: Request) {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  const query = buildAttendanceQuery(req.currentUser!, filters);
  const rows = await AttendanceModel.find(query)
    .sort({ branchName: 1, siteName: 1, date: -1, workerName: 1 })
    .limit(MAX_ROWS)
    .lean();
  return { filters, rows };
}

function reportSubtitle(filters: Record<string, unknown>): string {
  const bits: string[] = [];
  if (filters.dateFrom || filters.dateTo) bits.push(`${filters.dateFrom ?? "…"} → ${filters.dateTo ?? "…"}`);
  if (filters.designation) bits.push(String(filters.designation));
  if (filters.q) bits.push(`"${filters.q}"`);
  return bits.length ? bits.join(" · ") : "All records";
}

router.get("/reports/attendance", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { filters, rows } = await fetchRows(req);
  const [branches, sites, designations] = await Promise.all([
    BranchModel.find().sort({ name: 1 }).lean(),
    ProjectSiteModel.find().sort({ name: 1 }).lean(),
    DesignationModel.find().sort({ name: 1 }).lean(),
  ]);

  // Visualize the SAME filtered rows (no extra queries).
  const byDay = new Map<string, number>();
  const bySite = new Map<string, { count: number; ot: number }>();
  for (const r of rows) {
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + 1);
    const key = r.siteName ?? "—";
    const s = bySite.get(key) ?? { count: 0, ot: 0 };
    s.count += 1;
    s.ot += r.overtime?.computedHours ?? 0;
    bySite.set(key, s);
  }
  const dayKeys = [...byDay.keys()].sort();
  const siteKeys = [...bySite.keys()];
  const reportCharts = {
    byDay: { labels: dayKeys, data: dayKeys.map((d) => byDay.get(d) ?? 0) },
    bySite: { labels: siteKeys, count: siteKeys.map((s) => bySite.get(s)!.count), ot: siteKeys.map((s) => round2(bySite.get(s)!.ot)) },
  };
  const summary = {
    records: rows.length,
    employees: new Set(rows.map((r) => r.empRegNo)).size,
    otHours: round2(rows.reduce((a, r) => a + (r.overtime?.computedHours ?? 0), 0)),
    sites: new Set(rows.map((r) => r.siteName)).size,
  };

  res.render("reports/attendance", {
    title: "Attendance report · " + res.locals.company,
    active: "/reports",
    filters,
    groups: groupByBranchSite(rows),
    rowCount: rows.length,
    maxRows: MAX_ROWS,
    branches,
    sites,
    designations,
    hoursBreakdown,
    reportCharts,
    summary,
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/reports/attendance/export.xlsx", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { rows } = await fetchRows(req);
  const buf = await buildXlsxBuffer(rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${Date.now()}.xlsx"`);
  res.send(buf);
});

router.get("/reports/attendance/export.pdf", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { filters, rows } = await fetchRows(req);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${Date.now()}.pdf"`);
  streamPdf(rows, { title: `${res.locals.company} — Attendance Report`, subtitle: reportSubtitle(filters as Record<string, unknown>) }, res);
});

// ========================= Employee report =========================
async function employeeRows(req: Request) {
  const siteId = String(req.query.siteId ?? "");
  const designation = String(req.query.designation ?? "");
  const status = ["active", "inactive", "pending"].includes(String(req.query.status)) ? String(req.query.status) : "";
  const q: Record<string, unknown> = { ...workerScopeFilter(req.currentUser!) };
  q.status = status || { $in: ["active", "inactive"] };
  if (siteId && Types.ObjectId.isValid(siteId)) q.siteIds = new Types.ObjectId(siteId);
  if (designation) q.designationName = designation;
  const workers = await WorkerModel.find(q)
    .select("name empRegNo designationName siteName status dailyWage")
    .sort({ name: 1 })
    .limit(MAX_ROWS)
    .lean();
  const faceRegistered = await WorkerModel.countDocuments({ ...q, "faceEncoding.0": { $exists: true } });
  return { workers, faceRegistered, filters: { siteId, designation, status } };
}

router.get("/reports/employees", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, faceRegistered, filters } = await employeeRows(req);
  const [sites, designations] = await Promise.all([
    ProjectSiteModel.find().sort({ name: 1 }).lean(),
    DesignationModel.find().sort({ name: 1 }).lean(),
  ]);
  const byDesig = new Map<string, number>();
  const bySite = new Map<string, number>();
  for (const w of workers) {
    byDesig.set(w.designationName, (byDesig.get(w.designationName) ?? 0) + 1);
    bySite.set(w.siteName, (bySite.get(w.siteName) ?? 0) + 1);
  }
  const desigKeys = [...byDesig.keys()].sort((a, b) => (byDesig.get(b)! - byDesig.get(a)!));
  const siteKeys = [...bySite.keys()].sort((a, b) => (bySite.get(b)! - bySite.get(a)!));
  res.render("reports/employees", {
    title: "Employee report · " + res.locals.company,
    active: "/reports",
    workers,
    sites,
    designations,
    filters,
    summary: {
      total: workers.length,
      active: workers.filter((w) => w.status === "active").length,
      faceRegistered,
      facePending: workers.length - faceRegistered,
    },
    charts: {
      byDesignation: { labels: desigKeys, data: desigKeys.map((k) => byDesig.get(k)!) },
      bySite: { labels: siteKeys, data: siteKeys.map((k) => bySite.get(k)!) },
    },
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/reports/employees/export.csv", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers } = await employeeRows(req);
  sendCsv(
    res,
    `employees-${Date.now()}.csv`,
    ["Employee ID", "Name", "Designation", "Site", "Status", "Daily wage"],
    workers.map((w) => [w.empRegNo, w.name, w.designationName, w.siteName, w.status, w.dailyWage ?? ""]),
  );
});

// ========================= Overtime report =========================
async function overtimeData(req: Request) {
  const dateFrom = String(req.query.dateFrom ?? "");
  const dateTo = String(req.query.dateTo ?? "");
  const siteId = String(req.query.siteId ?? "");
  const q: Record<string, unknown> = { ...siteScopeFilter(req.currentUser!), "overtime.status": { $in: ["pending", "approved"] } };
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    const range: Record<string, string> = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) range.$gte = dateFrom;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) range.$lte = dateTo;
    q.date = range;
  }
  if (siteId && Types.ObjectId.isValid(siteId)) q.siteId = new Types.ObjectId(siteId);
  const rows = await AttendanceModel.find(q).select("siteName standardHours overtime workerId").limit(MAX_ROWS).lean();

  const workerIds = [...new Set(rows.map((r) => String(r.workerId)).filter((x) => x && x !== "undefined"))];
  const workers = await WorkerModel.find({ _id: { $in: workerIds } }).select("dailyWage").lean();
  const wageById = new Map(workers.map((w) => [String(w._id), w.dailyWage]));

  const bySite = new Map<string, { pending: number; approved: number; cost: number }>();
  let missingWage = 0;
  for (const r of rows) {
    const approved = r.overtime?.status === "approved";
    const otH = approved ? (r.overtime?.approvedHours ?? r.overtime?.computedHours ?? 0) : (r.overtime?.computedHours ?? 0);
    const wage = wageById.get(String(r.workerId));
    const std = r.standardHours;
    const cost = wage != null && std ? otH * (wage / std) * config.otMultiplier : 0;
    if (wage == null) missingWage += 1;
    const k = r.siteName ?? "—";
    const g = bySite.get(k) ?? { pending: 0, approved: 0, cost: 0 };
    if (approved) g.approved += otH; else g.pending += otH;
    g.cost += cost;
    bySite.set(k, g);
  }
  const siteKeys = [...bySite.keys()].sort((a, b) => (bySite.get(b)!.pending + bySite.get(b)!.approved) - (bySite.get(a)!.pending + bySite.get(a)!.approved));
  const groups = siteKeys.map((k) => ({ site: k, pending: round2(bySite.get(k)!.pending), approved: round2(bySite.get(k)!.approved), cost: Math.round(bySite.get(k)!.cost) }));
  const summary = {
    pendingHours: round2(groups.reduce((a, g) => a + g.pending, 0)),
    approvedHours: round2(groups.reduce((a, g) => a + g.approved, 0)),
    cost: groups.reduce((a, g) => a + g.cost, 0),
    sites: groups.length,
    missingWage,
  };
  return { groups, summary, filters: { dateFrom, dateTo, siteId } };
}

router.get("/reports/overtime", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { groups, summary, filters } = await overtimeData(req);
  const sites = await ProjectSiteModel.find().sort({ name: 1 }).lean();
  res.render("reports/overtime", {
    title: "Overtime report · " + res.locals.company,
    active: "/reports",
    groups,
    summary,
    filters,
    sites,
    otMultiplier: config.otMultiplier,
    charts: { labels: groups.map((g) => g.site), pending: groups.map((g) => g.pending), approved: groups.map((g) => g.approved), cost: groups.map((g) => g.cost) },
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/reports/overtime/export.csv", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { groups } = await overtimeData(req);
  sendCsv(
    res,
    `overtime-${Date.now()}.csv`,
    ["Site", "Pending OT hours", "Approved OT hours", "OT cost (INR)"],
    groups.map((g) => [g.site, g.pending, g.approved, g.cost]),
  );
});

export default router;
