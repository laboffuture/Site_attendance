import { Types, type HydratedDocument } from "mongoose";

import { AttendanceModel, type Attendance } from "../models/Attendance";
import type { GeoCapture } from "./geo";
import { selectShift, computeShiftOT, DEFAULT_SHIFTS, type SiteShifts, type ShiftType } from "./shift";
import { isDuplicateKeyError } from "./validate";
import { siteLocalDate, round2 } from "./time";

const OPEN_SESSION_LOOKBACK_MS = 20 * 3_600_000; // attach an Out to an In up to 20h old

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
 * Records a scan. A scan attaches to the worker's most-recent OPEN record (no
 * Out) whose In is within the last 20h — that scan becomes the Out, even across
 * midnight. Otherwise it's a new In, keyed to the shift's start date, with the
 * shift auto-selected from the scan time. On Out, standard + overtime are
 * computed via the shift engine; OT is left pending until approved.
 */
export async function recordScan(
  worker: ScanWorker,
  site: ScanSite,
  branchName: string,
  geo?: GeoCapture,
): Promise<ScanResult> {
  const now = new Date();
  const shifts = site.shifts ?? DEFAULT_SHIFTS;

  // Currently clocked IN (an open session within the last 20h, across midnight)?
  // Then this scan is the OUT.
  const open = await AttendanceModel.findOne({
    workerId: worker._id,
    outTime: null,
    inTime: { $gte: new Date(now.getTime() - OPEN_SESSION_LOOKBACK_MS) },
  }).sort({ inTime: -1 });
  if (open) return closeSession(open, shifts, now, geo);

  // No open session. If today's record already has an Out, the worker is coming
  // BACK — toggle to IN by re-opening it (punch-clock style). The first In stays
  // locked; the final Out still wins, so the day resolves to first-In / last-Out.
  const date = siteLocalDate(now);
  const existing = await AttendanceModel.findOne({ workerId: worker._id, date });
  if (existing) {
    // Open but older than the 20h window (the lookup above missed it) → close it.
    if (existing.outTime == null) return closeSession(existing, shifts, now, geo);
    return reopenSession(existing);
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
    });
    return { action: "in", date, inTime: now, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType };
  } catch (err) {
    // Race: a record appeared between the lookup and create.
    if (!isDuplicateKeyError(err)) throw err;
    const same = await AttendanceModel.findOne({ workerId: worker._id, date });
    if (!same) throw err;
    return same.outTime == null ? closeSession(same, shifts, now, geo) : reopenSession(same);
  }
}

/** Coming back after an Out — re-open the same day's record as IN. The first In
 *  stays; the Out + computed hours are cleared and recomputed on the final Out. */
async function reopenSession(rec: HydratedDocument<Attendance>): Promise<ScanResult> {
  rec.outTime = null;
  rec.totalHours = null;
  rec.standardHours = null;
  rec.overtime = { computedHours: 0, status: "none", approvedHours: null, approvedBy: null, approvedAt: null, notes: null };
  await rec.save();
  const shiftType = (rec.shiftType as ShiftType) ?? "day";
  return { action: "in", date: rec.date, inTime: rec.inTime, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType };
}

async function closeSession(rec: HydratedDocument<Attendance>, shifts: SiteShifts, now: Date, geo?: GeoCapture): Promise<ScanResult> {
  const shiftType = (rec.shiftType as ShiftType) ?? "day";
  const shift = shifts[shiftType] ?? DEFAULT_SHIFTS[shiftType];
  const { standardHours, overtimeHours, breakHours } = computeShiftOT(shift, rec.inTime, now);
  const totalHours = round2((now.getTime() - rec.inTime.getTime()) / 3_600_000);

  rec.outTime = now;
  if (geo) rec.outGeo = geo;
  rec.totalHours = totalHours;
  rec.standardHours = standardHours;
  rec.breakHours = breakHours;
  rec.overtime = {
    computedHours: overtimeHours,
    status: overtimeHours > 0 ? "pending" : "none",
    approvedHours: null,
    approvedBy: null,
    approvedAt: null,
    notes: null,
  };
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
