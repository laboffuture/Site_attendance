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
  // What happened: a punch landed (in/out), or a no-op (already in / not clocked in).
  outcome: "in" | "out" | "already_in" | "not_clocked_in";
  date: string;
  inTime: Date | null;
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

/** Fill a forgotten OUT on an open record: set outTime, recompute hours via the
 *  shared reckoner, close the trailing open sessions[] punch, and stamp outSource.
 *  Used by the supervisor close-out at submit (and available to HR corrections),
 *  so the submit screen, approval screen and payslip never disagree on OT. */
export function fillOut(rec: HydratedDocument<Attendance>, outTime: Date, lunch: number, outSource: "supervisor-filled" | "hr-filled"): void {
  const h = reckonHours(rec.inTime, outTime, lunch);
  rec.outTime = outTime;
  rec.totalHours = h.totalHours;
  rec.standardHours = h.standardHours;
  rec.breakHours = lunch;
  rec.outSource = outSource;
  rec.overtime.computedHours = h.overtimeHours;
  rec.overtime.status = h.overtimeHours > 0 ? "pending" : "none";
  const last = rec.sessions?.[rec.sessions.length - 1];
  if (last && last.outTime == null) last.outTime = outTime;
}

/** "IN" result — a fresh/re-opened IN, or the idempotent "already in" no-op. */
function inState(rec: HydratedDocument<Attendance>, outcome: "in" | "already_in" = "in"): ScanResult {
  return { outcome, date: rec.date, inTime: rec.inTime, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType: (rec.shiftType as ShiftType) ?? "day" };
}
/** "OUT" result (a close, or the re-shown state after an accidental OUT re-tap). */
function outState(rec: HydratedDocument<Attendance>): ScanResult {
  return { outcome: "out", date: rec.date, inTime: rec.inTime, outTime: rec.outTime ?? null, totalHours: rec.totalHours ?? null, standardHours: rec.standardHours ?? null, overtimeHours: rec.overtime?.computedHours ?? 0, overtimeStatus: rec.overtime?.status ?? "none", shiftType: (rec.shiftType as ShiftType) ?? "day" };
}
/** No-op: an OUT was requested but the worker isn't currently clocked in. */
function notClockedIn(date: string): ScanResult {
  return { outcome: "not_clocked_in", date, inTime: null, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none" };
}

/**
 * Records a scan with an EXPLICIT action (the worker/supervisor states IN or OUT —
 * the engine never guesses). One record per worker per day; first-In stays locked,
 * last-Out wins, so pay = first-In → last-Out − lunch.
 *
 *  - action="in": looks at TODAY's record ONLY. Already open today → "already_in"
 *    (no dup). Closed today → re-open (came back). No record today → first IN. A
 *    stale open record from a PRIOR day is NEVER touched (so clocking in today can't
 *    close yesterday's forgotten session).
 *  - action="out": closes the open session (today or a real ~24h shift within
 *    maxShiftHours). Not clocked in → "not_clocked_in" (nothing created); an
 *    accidental OUT re-tap within the debounce re-shows the closed state.
 */
export async function recordScan(
  worker: ScanWorker,
  site: ScanSite,
  branchName: string,
  action: "in" | "out",
  geo?: GeoCapture,
): Promise<ScanResult> {
  const now = new Date();
  const shifts = site.shifts ?? DEFAULT_SHIFTS;
  const lunch = site.lunchHours ?? 1;
  const maxMs = (site.maxShiftHours ?? config.maxShiftHours) * 3_600_000;
  const debounceMs = (site.scanDebounceSeconds ?? config.scanDebounceSeconds) * 1000;
  const date = siteLocalDate(now);

  if (action === "out") {
    // Close the open session — today's, or a long shift across midnight within maxShiftHours.
    const open = await AttendanceModel.findOne({
      workerId: worker._id,
      outTime: null,
      inTime: { $gte: new Date(now.getTime() - maxMs) },
    }).sort({ inTime: -1 });
    if (open) return closeSession(open, lunch, now, geo);
    // Accidental OUT double-tap: today's record just closed within the debounce → re-show.
    const today = await AttendanceModel.findOne({ workerId: worker._id, date });
    if (today && today.outTime && now.getTime() - new Date(today.outTime).getTime() < debounceMs) return outState(today);
    return notClockedIn(date);
  }

  // action === "in": TODAY's record only — a prior-day open record is never consulted.
  const today = await AttendanceModel.findOne({ workerId: worker._id, date });
  if (today) {
    if (today.outTime == null) return inState(today, "already_in"); // already clocked in
    return reopenSession(today, now, geo); // came back → re-open (first-In stays)
  }

  // Brand-new day → first IN (even if a prior-day record is still open elsewhere).
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
    return { outcome: "in", date, inTime: now, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType };
  } catch (err) {
    // Race: a record appeared between the lookup and create.
    if (!isDuplicateKeyError(err)) throw err;
    const same = await AttendanceModel.findOne({ workerId: worker._id, date });
    if (!same) throw err;
    return same.outTime == null ? inState(same, "already_in") : reopenSession(same, now, geo);
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
  return inState(rec, "in");
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
    outcome: "out",
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
