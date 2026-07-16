import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { config } from "../config";
import { buildPayrollXlsx, sendCsv, streamTablePdf } from "../lib/exporters";
import { computePayroll, ymd } from "../lib/payroll";
import { siteScopeFilter, canUseSite, canUseWorker } from "../lib/scope";
import { siteLocalDate } from "../lib/time";
import { PayrollAdjustmentModel } from "../models/PayrollAdjustment";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

async function payrollData(req: Request) {
  const u = req.currentUser!;
  const { dateFrom, dateTo, preset } = resolveRange(req);
  const siteId = String(req.query.siteId ?? "");
  const match: Record<string, unknown> = { ...siteScopeFilter(u), date: { $gte: dateFrom, $lte: dateTo } };
  if (siteId && Types.ObjectId.isValid(siteId) && canUseSite(u, siteId)) match.siteId = new Types.ObjectId(siteId);
  const { workers, summary, dates } = await computePayroll(match, dateFrom, dateTo);
  return { workers, summary, dates, filters: { dateFrom, dateTo, siteId, preset }, std: config.payrollStandardHours };
}

router.get("/payroll", requireCapability("view_payroll"), async (req: Request, res: Response) => {
  const { workers, summary, filters, std, dates } = await payrollData(req);
  const sites = await ProjectSiteModel.find({ status: { $ne: "deleted" } }).sort({ name: 1 }).lean();
  res.render("payroll/index", {
    title: "Payroll · " + res.locals.company,
    active: "/payroll",
    workers, summary, filters, sites, std, dates,
    otMultiplier: config.otMultiplier,
    query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "",
  });
});

// Save / update a worker's arrears for this exact pay period.
router.post("/payroll/arrears", requireCapability("view_payroll"), async (req: Request, res: Response) => {
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

router.get("/payroll/export.csv", requireCapability("view_payroll"), async (req: Request, res: Response) => {
  const { workers, filters } = await payrollData(req);
  sendCsv(res, `payroll-${filters.dateFrom}_to_${filters.dateTo}.csv`,
    ["S.No", "Emp Code", "Worker", "Designation", "Account No", "IFSC", "Basic", "Food", "Days", "Normal Hrs", "OT Hrs", "Normal Pay", "OT Pay", "Food Count", "Food Allowance", "Arrears", "Total Pay"],
    workers.map((w, i) => [i + 1, w.empRegNo, w.name, w.designation, w.account, w.ifsc, w.basic ?? "", w.food, w.days, w.normalHrs, w.otHrs, w.normalPay, w.otPay, w.foodDays, w.foodAllowance, w.arrears, w.gross]));
});

router.get("/payroll/export.xlsx", requireCapability("view_payroll"), async (req: Request, res: Response) => {
  const { workers, filters, dates } = await payrollData(req);
  const buf = await buildPayrollXlsx(workers, dates, `${filters.dateFrom} → ${filters.dateTo}`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="payroll-${filters.dateFrom}_to_${filters.dateTo}.xlsx"`);
  res.send(buf);
});

router.get("/payroll/export.pdf", requireCapability("view_payroll"), async (req: Request, res: Response) => {
  const { workers, filters } = await payrollData(req);
  const cols = [
    { header: "#", key: "sno", pdf: 26, align: "right" as const },
    { header: "Emp Code", key: "empRegNo", pdf: 92 },
    { header: "Worker", key: "name", pdf: 100 },
    { header: "Designation", key: "designation", pdf: 80 },
    { header: "Basic", key: "basic", pdf: 50, align: "right" as const },
    { header: "Days", key: "days", pdf: 34, align: "right" as const },
    { header: "Normal Hrs", key: "normalHrs", pdf: 58, align: "right" as const },
    { header: "OT Hrs", key: "otHrs", pdf: 46, align: "right" as const },
    { header: "Normal Pay", key: "normalPay", pdf: 64, align: "right" as const },
    { header: "OT Pay", key: "otPay", pdf: 52, align: "right" as const },
    { header: "Food", key: "foodAllowance", pdf: 48, align: "right" as const },
    { header: "Arrears", key: "arrears", pdf: 54, align: "right" as const },
    { header: "Gross", key: "gross", pdf: 62, align: "right" as const },
  ];
  const flat = workers.map((w, i) => ({ sno: i + 1, empRegNo: String(w.empRegNo ?? ""), name: String(w.name ?? ""), designation: String(w.designation ?? ""), basic: w.basic ?? "", days: w.days, normalHrs: w.normalHrs, otHrs: w.otHrs, normalPay: w.normalPay, otPay: w.otPay, foodAllowance: w.foodAllowance, arrears: w.arrears, gross: w.gross }));
  const sum = (k: "normalHrs" | "otHrs" | "normalPay" | "otPay" | "foodAllowance" | "arrears" | "gross") => Math.round(workers.reduce((a, w) => a + (Number(w[k]) || 0), 0) * 100) / 100;
  const totals = { name: "TOTAL", normalHrs: sum("normalHrs"), otHrs: sum("otHrs"), normalPay: sum("normalPay"), otPay: sum("otPay"), foodAllowance: sum("foodAllowance"), arrears: sum("arrears"), gross: sum("gross") };
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="payroll-${filters.dateFrom}_to_${filters.dateTo}.pdf"`);
  streamTablePdf(flat, cols, { title: `${res.locals.company} — Payroll`, subtitle: `${filters.dateFrom} -> ${filters.dateTo} · gross (normal + OT + food + arrears)`, company: res.locals.company, totals }, res);
});

export default router;
