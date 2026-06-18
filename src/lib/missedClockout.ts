/* Missed clock-out sweep (flag-only).
 *
 * Finds attendance records left open (In scanned, no Out) on or before a
 * site-local day and raises one `missed_clockout` flag per record. It never
 * modifies the attendance record — HR corrects the real out-time on the
 * /attendance page. Idempotent: a partial unique index on
 * {type, attendanceId} guarantees a record can be flagged at most once, so
 * re-running (the in-app timer + a manual `npm run sweep` on the same night)
 * is safe.
 *
 * The flag stores the worker's home site in BOTH homeSite* and attemptedSite*
 * so the existing flag scoping / resolve checks (keyed on attemptedSiteId)
 * and the /flags view work unchanged.
 */
import * as db from "../db";
import { AttendanceModel } from "../models/Attendance";
import { FlagEventModel } from "../models/FlagEvent";
import { siteLocalDate } from "./time";
import { isDuplicateKeyError } from "./validate";

export interface SweepSummary {
  scanned: number; // open records considered
  flagged: number; // new flags raised
  skipped: number; // already flagged (idempotent no-op)
}

/**
 * Sweep open attendance records with `date <= asOfDate` (defaults to today,
 * site-local IST) and raise a missed_clockout flag for each not already
 * flagged. No-ops with a warning if the database is not connected.
 */
export async function sweepMissedClockouts(asOfDate: string = siteLocalDate()): Promise<SweepSummary> {
  const summary: SweepSummary = { scanned: 0, flagged: 0, skipped: 0 };
  if (!db.dbReady) {
    console.warn("Missed-clockout sweep skipped: database not connected.");
    return summary;
  }

  const open = await AttendanceModel.find({ outTime: null, date: { $lte: asOfDate } })
    .select("workerId workerName siteId siteName date")
    .lean();

  for (const rec of open) {
    summary.scanned++;
    try {
      await FlagEventModel.create({
        type: "missed_clockout",
        workerId: rec.workerId,
        workerName: rec.workerName,
        attendanceId: rec._id,
        date: rec.date,
        // Home site = the record's site; mirrored to attemptedSite* so the
        // existing site-scoped flag queries and resolve checks apply.
        homeSiteId: rec.siteId,
        homeSiteName: rec.siteName,
        attemptedSiteId: rec.siteId,
        attemptedSiteName: rec.siteName,
      });
      summary.flagged++;
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        summary.skipped++; // already flagged on a previous run
        continue;
      }
      throw err;
    }
  }

  console.log(
    `Missed-clockout sweep (as of ${asOfDate}): scanned ${summary.scanned}, flagged ${summary.flagged}, skipped ${summary.skipped}.`,
  );
  return summary;
}
