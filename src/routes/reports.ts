import { Router, Request, Response } from "express";

import { requireCapability } from "../auth/middleware";
import { buildXlsxBuffer, streamPdf } from "../lib/exporters";
import { parseReportFilters, buildAttendanceQuery, groupByBranchSite } from "../lib/report";
import { AttendanceModel } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { DesignationModel } from "../models/Designation";
import { ProjectSiteModel } from "../models/ProjectSite";

const router = Router();
const MAX_ROWS = 5000;

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

// Report page: filters + grouped table + export buttons.
router.get("/reports", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { filters, rows } = await fetchRows(req);
  const [branches, sites, designations] = await Promise.all([
    BranchModel.find().sort({ name: 1 }).lean(),
    ProjectSiteModel.find().sort({ name: 1 }).lean(),
    DesignationModel.find().sort({ name: 1 }).lean(),
  ]);
  res.render("reports/index", {
    title: "Reports · " + res.locals.company,
    active: "/reports",
    filters,
    groups: groupByBranchSite(rows),
    rowCount: rows.length,
    maxRows: MAX_ROWS,
    branches,
    sites,
    designations,
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/reports/export.xlsx", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { rows } = await fetchRows(req);
  const buf = await buildXlsxBuffer(rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${Date.now()}.xlsx"`);
  res.send(buf);
});

router.get("/reports/export.pdf", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { filters, rows } = await fetchRows(req);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${Date.now()}.pdf"`);
  streamPdf(
    rows,
    { title: `${res.locals.company} — Attendance Report`, subtitle: reportSubtitle(filters as Record<string, unknown>) },
    res,
  );
});

export default router;
