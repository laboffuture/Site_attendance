import { Types } from "mongoose";

import { AttendanceModel } from "../models/Attendance";
import type { GeoCapture } from "./geo";
import { isDuplicateKeyError } from "./validate";
import { siteLocalDate, standardHoursForSite, round2 } from "./time";

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
  standardStartTime: string;
  standardEndTime: string;
  designationOverrides?: { designationId: Types.ObjectId; startTime: string; endTime: string }[];
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
}

/**
 * Records a scan for a worker at their (already location-validated) site.
 * First scan of the site-local day = In; any later scan updates Out to now
 * (last-scan-wins) and (re)computes total + overtime. Overtime is left
 * pending — it is not final until approved.
 */
export async function recordScan(
  worker: ScanWorker,
  site: ScanSite,
  branchName: string,
  geo?: GeoCapture,
): Promise<ScanResult> {
  const date = siteLocalDate();
  const now = new Date();

  let rec = await AttendanceModel.findOne({ workerId: worker._id, date });

  if (!rec) {
    try {
      rec = await AttendanceModel.create({
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
        inGeo: geo ?? undefined,
        source: "scan",
      });
      return {
        action: "in",
        date,
        inTime: now,
        outTime: null,
        totalHours: null,
        standardHours: null,
        overtimeHours: 0,
        overtimeStatus: "none",
      };
    } catch (err) {
      // Two near-simultaneous first scans: the unique {workerId,date} index
      // rejects the second — fall through and treat it as the Out scan.
      if (!isDuplicateKeyError(err)) throw err;
      rec = await AttendanceModel.findOne({ workerId: worker._id, date });
      if (!rec) throw err;
    }
  }

  // Out (last-scan-wins)
  const totalHours = round2((now.getTime() - rec.inTime.getTime()) / 3_600_000);
  const standardHours = round2(standardHoursForSite(site, String(worker.designationId)));
  const overtimeHours = round2(Math.max(0, totalHours - standardHours));

  rec.outTime = now;
  if (geo) rec.outGeo = geo;
  rec.totalHours = totalHours;
  rec.standardHours = standardHours;
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
    date,
    inTime: rec.inTime,
    outTime: now,
    totalHours,
    standardHours,
    overtimeHours,
    overtimeStatus: rec.overtime.status,
  };
}
