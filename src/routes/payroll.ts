import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { config } from "../config";
import { buildPayrollXlsx, sendCsv } from "../lib/exporters";
import { siteScopeFilter, canUseSite } from "../lib/scope";
import { round2, siteLocalDate } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { ProjectSiteModel } from "../models/ProjectSite";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Mon–Sun pay-week containing `baseYmd`, shifted by `offsetWeeks`. */
function weekBounds(baseYmd: string, offsetWeeks: number): { dateFrom: string; dateTo: string } {
  const d = new Date(baseYmd + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  const mon = new Date(d);
  mon.setDate(d.getDate() - dow + offsetWeeks * 7);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { dateFrom: ymd(mon), dateTo: ymd(sun) };
}

/** Resolves the active date range from a preset or explicit from/to (default: this week). */
function resolveRange(req: Request): { dateFrom: string; dateTo: string; preset: string } {
  const today = siteLocalDate();
  const preset = String(req.query.preset ?? "");
  const qFrom = String(req.query.dateFrom ?? "");
  const qTo = String(req.query.dateTo ?? "");
  if (preset === "last-week") { const w = weekBounds(today, -1); return { ...w, preset }; }
  if (preset === "this-month") return { dateFrom: today.slice(0, 8) + "01", dateTo: today, preset };
  if (DATE_RE.test(qFrom) && DATE_RE.test(qTo)) return { dateFrom: qFrom, dateTo: qTo, preset: "custom" };
  const w = weekBounds(today, 0);
  return { ...w, preset: "this-week" };
}

// Per-worker hours + pay over the period, matching the client OT sheet:
//   normal = min(day total, standardDay) summed; OT = beyond standardDay summed;
//   hourly = BASIC / standardDay; OT paid at config.otMultiplier (×1 per the sheet);
//   food paid on days worked >= 5h; gross = normal pay + OT pay + food.
async function payrollData(req: Request) {
  const u = req.currentUser!;
  const { dateFrom, dateTo, preset } = resolveRange(req);
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
  return { workers, summary, filters: { dateFrom, dateTo, siteId, preset }, std: STD };
}

router.get("/payroll", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, summary, filters, std } = await payrollData(req);
  const sites = await ProjectSiteModel.find().sort({ name: 1 }).lean();
  res.render("payroll/index", {
    title: "Payroll · " + res.locals.company,
    active: "/payroll",
    workers, summary, filters, sites, std,
    otMultiplier: config.otMultiplier,
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

router.get("/payroll/export.csv", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, filters } = await payrollData(req);
  sendCsv(res, `payroll-${filters.dateFrom}_to_${filters.dateTo}.csv`,
    ["S.No", "Emp Code", "Worker", "Designation", "Account No", "IFSC", "Basic", "Food", "Days", "Normal Hrs", "OT Hrs", "Normal Pay", "OT Pay", "Food Count", "Food Allowance", "Total Pay"],
    workers.map((w, i) => [i + 1, w.empRegNo, w.name, w.designation, w.account, w.ifsc, w.basic ?? "", w.food, w.days, w.normalHrs, w.otHrs, w.normalPay, w.otPay, w.foodDays, w.foodAllowance, w.gross]));
});

router.get("/payroll/export.xlsx", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, filters } = await payrollData(req);
  const buf = await buildPayrollXlsx(workers, `${filters.dateFrom} → ${filters.dateTo}`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="payroll-${filters.dateFrom}_to_${filters.dateTo}.xlsx"`);
  res.send(buf);
});

export default router;
