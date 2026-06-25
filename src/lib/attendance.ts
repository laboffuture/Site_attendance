import { Types, type HydratedDocument } from "mongoose";

import { config } from "../config";
import { AttendanceModel, type Attendance } from "../models/Attendance";
import type { GeoCapture } from "./geo";
import { selectShift, DEFAULT_SHIFTS, type SiteShifts, type ShiftType } from "./shift";
import { isDuplicateKeyError } from "./validate";
import { siteLocalDate, round2 } from "./time";

interface ScanWorker {
  _id: Types.ObjectId;
  empRegNo: string;
  name: string;
  designationId: Types.ObjectId;
  designationName: string;
}

interface ScanSite {
  _id: Types.ObjectId;
  name: string;
  branchId: Types.ObjectId;
  shifts?: SiteShifts | null;
  lunchHours?: number | null;
  maxShiftHours?: number | null;
  scanDebounceSeconds?: number | null;
}

export interface ScanResult {
  action: "in" | "out";
  date: string;
  inTime: Date;
  outTime: Date | null;
  totalHours: number | null;
  standardHours: number | null;
  overtimeHours: number;
  overtimeStatus: string;
  shiftType?: ShiftType;
}

/**
 * One closed day's hours under the client OT sheet: paid = span − lunch;
 * normal = min(paid, standardDay); OT = flat max(0, paid − standardDay), with NO
 * second-break deduction. Single source of truth for the scan close AND HR
 * corrections, so the approval screen, dashboard and payslip all read the same OT.
 */
export function reckonHours(
  inTime: Date,
  outTime: Date,
  lunch: number,
): { totalHours: number; standardHours: number; overtimeHours: number } {
  const span = round2(Math.max(0, (outTime.getTime() - inTime.getTime()) / 3_600_000));
  const paid = round2(Math.max(0, span - lunch));
  const std = config.payrollStandardHours;
  return { totalHours: span, standardHours: round2(Math.min(paid, std)), overtimeHours: round2(Math.max(0, paid - std)) };
}

/** Idempotent "still IN" result (returned when a re-tap is debounced). */
function inState(rec: HydratedDocument<Attendance>): ScanResult {
  return { action: "in", date: rec.date, inTime: rec.inTime, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType: (rec.shiftType as ShiftType) ?? "day" };
}
/** Idempotent "still OUT" result (returned when a re-tap is debounced). */
function outState(rec: HydratedDocument<Attendance>): ScanResult {
  return { action: "out", date: rec.date, inTime: rec.inTime, outTime: rec.outTime ?? null, totalHours: rec.totalHours ?? null, standardHours: rec.standardHours ?? null, overtimeHours: rec.overtime?.computedHours ?? 0, overtimeStatus: rec.overtime?.status ?? "none", shiftType: (rec.shiftType as ShiftType) ?? "day" };
}

/**
 * Records a scan (punch-clock). A scan attaches to the worker's most-recent OPEN
 * record (no Out) whose In is within `maxShiftHours` — that scan becomes the Out,
 * even across midnight (so a true ~24h shift closes correctly). If the day is
 * already closed and the worker scans again, the day re-opens as IN (they came
 * back); the first In stays locked and the last Out wins, so pay = first-In →
 * last-Out − lunch. A repeat scan within `scanDebounceSeconds` is ignored.
 */
export async function recordScan(
  worker: ScanWorker,
  site: ScanSite,
  branchName: string,
  geo?: GeoCapture,
): Promise<ScanResult> {
  const now = new Date();
  const shifts = site.shifts ?? DEFAULT_SHIFTS;
  const lunch = site.lunchHours ?? 1;
  const maxMs = (site.maxShiftHours ?? config.maxShiftHours) * 3_600_000;
  const debounceMs = (site.scanDebounceSeconds ?? config.scanDebounceSeconds) * 1000;

  // Currently clocked IN (an open session within maxShiftHours, across midnight)?
  // Then this scan is the OUT.
  const open = await AttendanceModel.findOne({
    workerId: worker._id,
    outTime: null,
    inTime: { $gte: new Date(now.getTime() - maxMs) },
  }).sort({ inTime: -1 });
  if (open) {
    // Debounce: a re-tap moments after clocking in must not close the session.
    if (now.getTime() - new Date(open.inTime).getTime() < debounceMs) return inState(open);
    return closeSession(open, lunch, now, geo);
  }

  // No open session. Today's record?
  const date = siteLocalDate(now);
  const existing = await AttendanceModel.findOne({ workerId: worker._id, date });
  if (existing) {
    // Debounce: a re-tap moments after clocking out must not re-open the day.
    if (existing.outTime && now.getTime() - new Date(existing.outTime).getTime() < debounceMs) return outState(existing);
    // Open but older than the window (the lookup above missed it) → close it.
    if (existing.outTime == null) return closeSession(existing, lunch, now, geo);
    // Already closed and the worker is back → re-open as IN (punch-clock).
    return reopenSession(existing, now, geo);
  }

  // Brand-new day → first IN.
  const shiftType = selectShift(shifts, now);
  try {
    await AttendanceModel.create({
      date,
      workerId: worker._id,
      empRegNo: worker.empRegNo,
      workerName: worker.name,
      designationId: worker.designationId,
      designationName: worker.designationName,
      siteId: site._id,
      siteName: site.name,
      branchId: site.branchId,
      branchName,
      inTime: now,
      shiftType,
      inGeo: geo ?? undefined,
      source: "scan",
      sessions: [{ inTime: now, outTime: null, inGeo: geo ?? null, outGeo: null, source: "scan" }],
    });
    return { action: "in", date, inTime: now, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType };
  } catch (err) {
    // Race: a record appeared between the lookup and create.
    if (!isDuplicateKeyError(err)) throw err;
    const same = await AttendanceModel.findOne({ workerId: worker._id, date });
    if (!same) throw err;
    return same.outTime == null ? closeSession(same, lunch, now, geo) : reopenSession(same, now, geo);
  }
}

/** Coming back after an Out — re-open the same day's record as IN. The first In
 *  stays locked; the Out + computed hours are cleared (recomputed on the final
 *  Out); a new punch is logged in sessions[]. */
async function reopenSession(rec: HydratedDocument<Attendance>, now: Date, geo?: GeoCapture): Promise<ScanResult> {
  rec.outTime = null;
  rec.totalHours = null;
  rec.standardHours = null;
  rec.breakHours = null;
  rec.outSource = null;
  rec.overtime = { computedHours: 0, status: "none", approvedHours: null, recommendedBy: null, recommendedAt: null, approvedBy: null, approvedAt: null, notes: null };
  rec.sessions.push({ inTime: now, outTime: null, inGeo: (geo ?? null) as never, outGeo: null, source: "scan" });
  await rec.save();
  return inState(rec);
}

/** This scan is the Out: compute hours via the flat client-sheet reckoner, mark
 *  the Out as scanned, and close the open punch in sessions[]. */
async function closeSession(rec: HydratedDocument<Attendance>, lunch: number, now: Date, geo?: GeoCapture): Promise<ScanResult> {
  const shiftType = (rec.shiftType as ShiftType) ?? "day";
  const { totalHours, standardHours, overtimeHours } = reckonHours(rec.inTime, now, lunch);

  rec.outTime = now;
  if (geo) rec.outGeo = geo;
  rec.totalHours = totalHours;
  rec.standardHours = standardHours;
  rec.breakHours = lunch;
  rec.outSource = "scanned";
  rec.overtime = {
    computedHours: overtimeHours,
    status: overtimeHours > 0 ? "pending" : "none",
    approvedHours: null,
    recommendedBy: null,
    recommendedAt: null,
    approvedBy: null,
    approvedAt: null,
    notes: null,
  };
  // Close the open punch in the session log.
  const last = rec.sessions?.[rec.sessions.length - 1];
  if (last && last.outTime == null) {
    last.outTime = now;
    if (geo) last.outGeo = geo as never;
  }
  await rec.save();

  return {
    action: "out",
    date: rec.date,
    inTime: rec.inTime,
    outTime: now,
    totalHours,
    standardHours,
    overtimeHours,
    overtimeStatus: rec.overtime.status,
    shiftType,
  };
}
