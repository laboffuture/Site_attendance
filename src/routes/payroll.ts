import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { config } from "../config";
import { buildPayrollXlsx, sendCsv } from "../lib/exporters";
import { siteScopeFilter, canUseSite, canUseWorker } from "../lib/scope";
import { round2, siteLocalDate } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { PayrollAdjustmentModel } from "../models/PayrollAdjustment";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROW_CAP = 20000;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const istTime = (d: unknown) => (d ? new Date(d as string).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "");

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
  if (preset === "last-week") return { ...weekBounds(today, -1), preset };
  if (preset === "this-month") return { dateFrom: today.slice(0, 8) + "01", dateTo: today, preset };
  if (DATE_RE.test(qFrom) && DATE_RE.test(qTo)) return { dateFrom: qFrom, dateTo: qTo, preset: "custom" };
  return { ...weekBounds(today, 0), preset: "this-week" };
}

/** One day's worked hours = (Out − In) − site lunch; falls back to the stored
 *  total when in/out aren't both present (e.g. manual entries). */
function dayHours(inTime: unknown, outTime: unknown, lunch: number, fallback: number | null | undefined): number {
  if (inTime && outTime) {
    const h = (new Date(outTime as string).getTime() - new Date(inTime as string).getTime()) / 3600000;
    return round2(Math.max(0, (h < 0 ? 0 : h) - lunch));
  }
  return round2(fallback ?? 0);
}

// Per-worker hours + pay over the period, matching the client OT sheet:
//   day total = (Out−In) − site lunch; normal = min(total, standardDay);
//   OT = beyond standardDay; hourly = BASIC / standardDay; OT × otMultiplier;
//   food on days worked ≥ 5h; gross = normal + OT + food + arrears.
async function payrollData(req: Request) {
  const u = req.currentUser!;
  const { dateFrom, dateTo, preset } = resolveRange(req);
  const siteId = String(req.query.siteId ?? "");
  const STD = config.payrollStandardHours;
  const match: Record<string, unknown> = { ...siteScopeFilter(u), date: { $gte: dateFrom, $lte: dateTo } };
  if (siteId && Types.ObjectId.isValid(siteId) && canUseSite(u, siteId)) match.siteId = new Types.ObjectId(siteId);

  const att = await AttendanceModel.find(match)
    .select("workerId empRegNo workerName designationName siteId siteName date inTime outTime totalHours")
    .sort({ workerName: 1, date: 1 }).limit(ROW_CAP).lean();

  const siteIds = [...new Set(att.map((r) => String(r.siteId)).filter(Boolean))];
  const workerIds = [...new Set(att.map((r) => String(r.workerId)).filter(Boolean))];
  const [siteDocs, workerDocs, adjustments] = await Promise.all([
    ProjectSiteModel.find({ _id: { $in: siteIds } }).select("lunchHours").lean(),
    WorkerModel.find({ _id: { $in: workerIds } }).select("dailyWage foodAllowance bank").lean(),
    PayrollAdjustmentModel.find({ workerId: { $in: workerIds }, dateFrom, dateTo }).lean(),
  ]);
  const lunchBySite = new Map(siteDocs.map((s) => [String(s._id), typeof s.lunchHours === "number" ? s.lunchHours : 1]));
  const wmap = new Map(workerDocs.map((w) => [String(w._id), w]));
  const arrearsByWorker = new Map(adjustments.map((a) => [String(a.workerId), a]));

  const dates: string[] = [];
  for (let d = new Date(dateFrom + "T00:00:00"), end = new Date(dateTo + "T00:00:00"); d <= end; d.setDate(d.getDate() + 1)) dates.push(ymd(d));

  type Day = { inT: string; outT: string; lunch: number; total: number; normal: number; ot: number };
  const byWorker = new Map<string, { empRegNo: string; name: string; designation: string; siteName: string; byDate: Record<string, Day> }>();
  for (const r of att) {
    const key = String(r.workerId);
    if (!byWorker.has(key)) byWorker.set(key, { empRegNo: r.empRegNo, name: r.workerName, designation: r.designationName, siteName: r.siteName, byDate: {} });
    const lunch = lunchBySite.get(String(r.siteId)) ?? 1;
    const total = dayHours(r.inTime, r.outTime, lunch, r.totalHours);
    byWorker.get(key)!.byDate[r.date] = { inT: istTime(r.inTime), outT: istTime(r.outTime), lunch, total, normal: Math.min(total, STD), ot: round2(Math.max(0, total - STD)) };
  }

  const mult = config.otMultiplier;
  const workers = [...byWorker.entries()].map(([id, wd]) => {
    const w = wmap.get(id) as { dailyWage?: number; foodAllowance?: { applicable?: boolean; amount?: number }; bank?: { accountNumber?: string; ifsc?: string } } | undefined;
    const wage = w?.dailyWage ?? null;
    const foodRate = w?.foodAllowance?.applicable ? (w.foodAllowance.amount ?? 0) : 0;
    const hourly = wage != null ? wage / STD : 0;
    let normalHrs = 0, otHrs = 0, foodDays = 0;
    const days = Object.keys(wd.byDate).length;
    for (const date of Object.keys(wd.byDate)) {
      const d = wd.byDate[date];
      normalHrs += d.normal; otHrs += d.ot; if (d.total >= 5) foodDays++;
    }
    const normalPay = Math.round(normalHrs * hourly);
    const otPay = Math.round(otHrs * hourly * mult);
    const foodAllowance = Math.round(foodRate * foodDays);
    const adj = arrearsByWorker.get(id);
    const arrears = adj?.amount ?? 0;
    return {
      workerId: id, empRegNo: wd.empRegNo, name: wd.name, designation: wd.designation, siteName: wd.siteName,
      account: w?.bank?.accountNumber ?? "", ifsc: w?.bank?.ifsc ?? "",
      basic: wage, food: foodRate, days, normalHrs: round2(normalHrs), otHrs: round2(otHrs), foodDays,
      normalPay, otPay, foodAllowance, arrears, arrearsNote: adj?.note ?? "",
      gross: normalPay + otPay + foodAllowance + arrears, hasWage: wage != null, byDate: wd.byDate,
    };
  }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const summary = {
    workers: workers.length,
    normalHrs: round2(workers.reduce((a, w) => a + w.normalHrs, 0)),
    otHrs: round2(workers.reduce((a, w) => a + w.otHrs, 0)),
    arrears: workers.reduce((a, w) => a + w.arrears, 0),
    gross: workers.reduce((a, w) => a + w.gross, 0),
    missingWage: workers.filter((w) => !w.hasWage).length,
    capped: att.length >= ROW_CAP,
  };
  return { workers, summary, filters: { dateFrom, dateTo, siteId, preset }, std: STD, dates };
}

router.get("/payroll", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, summary, filters, std, dates } = await payrollData(req);
  const sites = await ProjectSiteModel.find().sort({ name: 1 }).lean();
  res.render("payroll/index", {
    title: "Payroll · " + res.locals.company,
    active: "/payroll",
    workers, summary, filters, sites, std, dates,
    otMultiplier: config.otMultiplier,
    canEdit: true,
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

// Save / update a worker's arrears for this exact pay period.
router.post("/payroll/arrears", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const workerId = String(req.body.workerId ?? "");
  const dateFrom = String(req.body.dateFrom ?? "");
  const dateTo = String(req.body.dateTo ?? "");
  const amount = Math.round(Number(req.body.amount) || 0);
  const note = String(req.body.note ?? "").trim() || null;
  const siteId = String(req.body.siteId ?? "");
  if (Types.ObjectId.isValid(workerId) && DATE_RE.test(dateFrom) && DATE_RE.test(dateTo)) {
    const worker = await WorkerModel.findById(workerId).lean();
    if (worker && canUseWorker(u, worker)) {
      await PayrollAdjustmentModel.updateOne(
        { workerId: new Types.ObjectId(workerId), dateFrom, dateTo },
        { $set: { amount, note, updatedBy: new Types.ObjectId(u.id), updatedByName: u.name } },
        { upsert: true },
      );
    }
  }
  const params = new URLSearchParams({ dateFrom, dateTo });
  if (siteId) params.set("siteId", siteId);
  res.redirect("/payroll?" + params.toString());
});

router.get("/payroll/export.csv", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, filters } = await payrollData(req);
  sendCsv(res, `payroll-${filters.dateFrom}_to_${filters.dateTo}.csv`,
    ["S.No", "Emp Code", "Worker", "Designation", "Account No", "IFSC", "Basic", "Food", "Days", "Normal Hrs", "OT Hrs", "Normal Pay", "OT Pay", "Food Count", "Food Allowance", "Arrears", "Total Pay"],
    workers.map((w, i) => [i + 1, w.empRegNo, w.name, w.designation, w.account, w.ifsc, w.basic ?? "", w.food, w.days, w.normalHrs, w.otHrs, w.normalPay, w.otPay, w.foodDays, w.foodAllowance, w.arrears, w.gross]));
});

router.get("/payroll/export.xlsx", requireCapability("view_dashboard"), async (req: Request, res: Response) => {
  const { workers, filters, dates } = await payrollData(req);
  const buf = await buildPayrollXlsx(workers, dates, `${filters.dateFrom} → ${filters.dateTo}`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="payroll-${filters.dateFrom}_to_${filters.dateTo}.xlsx"`);
  res.send(buf);
});

export default router;
