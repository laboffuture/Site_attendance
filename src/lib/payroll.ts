import { config } from "../config";
import { round2 } from "./time";
import { AttendanceModel } from "../models/Attendance";
import { PayrollAdjustmentModel } from "../models/PayrollAdjustment";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const ROW_CAP = 20000;
const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const istTime = (d: unknown) => (d ? new Date(d as string).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "");

/** One day's worked hours = (Out − In) − site lunch; falls back to the stored
 *  total when in/out aren't both present (e.g. manual entries). */
function dayHours(inTime: unknown, outTime: unknown, lunch: number, fallback: number | null | undefined): number {
  if (inTime && outTime) {
    const h = (new Date(outTime as string).getTime() - new Date(inTime as string).getTime()) / 3600000;
    return round2(Math.max(0, (h < 0 ? 0 : h) - lunch));
  }
  return round2(fallback ?? 0);
}

export interface PayrollDay { inT: string; outT: string; lunch: number; total: number; normal: number; ot: number; }
export interface PayrollWorker {
  workerId: string; empRegNo: string; name: string; designation: string; siteName: string;
  account: string; ifsc: string; basic: number | null; food: number;
  days: number; normalHrs: number; otHrs: number; foodDays: number;
  normalPay: number; otPay: number; foodAllowance: number; arrears: number; arrearsNote: string;
  gross: number; hasWage: boolean; unresolvedOpenDays: number; byDate: Record<string, PayrollDay>;
}
export interface PayrollSummary {
  workers: number; normalHrs: number; otHrs: number; otCost: number; arrears: number; gross: number; missingWage: number; unresolvedOpenDays: number; capped: boolean;
}

/** Single source of truth for a payroll run over `match` across [dateFrom, dateTo].
 *  Used by the Payroll page and the Dashboard money board so figures agree. */
export async function computePayroll(match: Record<string, unknown>, dateFrom: string, dateTo: string): Promise<{ workers: PayrollWorker[]; summary: PayrollSummary; dates: string[] }> {
  const STD = config.payrollStandardHours;
  const mult = config.otMultiplier;

  const att = await AttendanceModel.find(match)
    .select("workerId empRegNo workerName designationName siteId siteName date inTime outTime totalHours breakHours overtime attendanceStatus voided")
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

  const reqApproval = config.otRequiresApproval;
  let unresolvedTotal = 0;
  const byWorker = new Map<string, { empRegNo: string; name: string; designation: string; siteName: string; byDate: Record<string, PayrollDay>; unresolved: number }>();
  for (const r of att) {
    if (r.voided) continue;                          // discarded by HR
    if (r.attendanceStatus === "rejected") continue; // a rejected day is a non-day
    const key = String(r.workerId);
    if (!byWorker.has(key)) byWorker.set(key, { empRegNo: r.empRegNo, name: r.workerName, designation: r.designationName, siteName: r.siteName, byDate: {}, unresolved: 0 });
    const wd = byWorker.get(key)!;
    if (r.outTime == null) { wd.unresolved++; unresolvedTotal++; continue; } // forgotten OUT → pay nil, flagged
    // Freeze pay to the lunch actually applied at close (the stored breakHours), so a
    // later edit to the site's lunch config can't retroactively change historical pay.
    // Legacy rows with no stored breakHours fall back to the live site lunch.
    const lunch = typeof r.breakHours === "number" ? r.breakHours : (lunchBySite.get(String(r.siteId)) ?? 1);
    const total = dayHours(r.inTime, r.outTime, lunch, r.totalHours);
    // OT pays only once Management-approved (config.otRequiresApproval). Normal pays on any
    // non-rejected, non-open, non-voided day. Keeps payslip OT == approval-screen OT.
    const ov = (r.overtime ?? {}) as { status?: string; computedHours?: number; approvedHours?: number | null };
    const otComputed = round2(Math.max(0, total - STD));
    const otPaid = reqApproval
      ? (ov.status === "approved" ? (ov.approvedHours ?? otComputed) : 0)
      : otComputed;
    wd.byDate[r.date] = { inT: istTime(r.inTime), outT: istTime(r.outTime), lunch, total, normal: Math.min(total, STD), ot: round2(otPaid) };
  }

  const workers: PayrollWorker[] = [...byWorker.entries()].map(([id, wd]) => {
    const w = wmap.get(id) as { dailyWage?: number; foodAllowance?: { applicable?: boolean; amount?: number }; bank?: { accountNumber?: string; ifsc?: string } } | undefined;
    const wage = w?.dailyWage ?? null;
    const foodRate = w?.foodAllowance?.applicable ? (w.foodAllowance.amount ?? 0) : 0;
    const hourly = wage != null ? wage / STD : 0;
    let normalHrs = 0, otHrs = 0, foodDays = 0;
    const days = Object.keys(wd.byDate).length;
    for (const date of Object.keys(wd.byDate)) {
      const d = wd.byDate[date];
      normalHrs += d.normal; otHrs += d.ot; if (d.total >= config.foodMinHours) foodDays++;
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
      gross: normalPay + otPay + foodAllowance + arrears, hasWage: wage != null, unresolvedOpenDays: wd.unresolved, byDate: wd.byDate,
    };
  }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const summary: PayrollSummary = {
    workers: workers.length,
    normalHrs: round2(workers.reduce((a, w) => a + w.normalHrs, 0)),
    otHrs: round2(workers.reduce((a, w) => a + w.otHrs, 0)),
    otCost: workers.reduce((a, w) => a + w.otPay, 0),
    arrears: workers.reduce((a, w) => a + w.arrears, 0),
    gross: workers.reduce((a, w) => a + w.gross, 0),
    missingWage: workers.filter((w) => !w.hasWage).length,
    unresolvedOpenDays: unresolvedTotal,
    capped: att.length >= ROW_CAP,
  };
  return { workers, summary, dates };
}

/** Rupee exposure of OT rows matching `match` (e.g. pending OT) — hours costed
 *  at the same hourly basis as payroll (dailyWage ÷ standardDay × otMultiplier). */
export async function otExposure(match: Record<string, unknown>): Promise<{ hrs: number; cost: number; count: number }> {
  const STD = config.payrollStandardHours;
  const mult = config.otMultiplier;
  const agg = await AttendanceModel.aggregate([
    { $match: match },
    { $lookup: { from: "workers", localField: "workerId", foreignField: "_id", as: "w" } },
    { $addFields: { wage: { $ifNull: [{ $arrayElemAt: ["$w.dailyWage", 0] }, 0] }, h: { $ifNull: ["$overtime.computedHours", 0] } } },
    { $group: { _id: null, hrs: { $sum: "$h" }, cost: { $sum: { $multiply: ["$h", { $divide: ["$wage", STD] }, mult] } }, count: { $sum: 1 } } },
  ]);
  const r = agg[0] ?? {};
  return { hrs: round2(r.hrs || 0), cost: Math.round(r.cost || 0), count: r.count || 0 };
}
