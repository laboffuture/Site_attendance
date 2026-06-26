/* Forgot-to-submit sweep (flag-only).
 *
 * Finds site-days whose attendance is still in "scanned" status — the supervisor
 * scanned workers but never submitted the day — on days strictly BEFORE today,
 * and raises one `forgot_submit` flag per (site, date). It never modifies the
 * attendance records. Idempotent: the partial-unique index on
 * {type, attemptedSiteId, date} guarantees a site-day is flagged at most once, so
 * re-running (the nightly timer, a boot catch-up, and a manual `npm run sweep`) is
 * safe. The flag carries the site as both attemptedSite* (so the existing flag
 * scoping / resolve checks apply) and homeSite*.
 */
import * as db from "../db";
import { AttendanceModel } from "../models/Attendance";
import { FlagEventModel } from "../models/FlagEvent";
import { siteLocalDate } from "./time";
import { isDuplicateKeyError } from "./validate";

export interface ForgotSubmitSummary {
  scanned: number; // site-days considered
  flagged: number; // new flags raised
  skipped: number; // already flagged (idempotent no-op)
}

/**
 * Sweep site-days still "scanned" with `date < asOfDate` (defaults to today,
 * site-local IST — so the CURRENT day, which simply hasn't been submitted yet, is
 * never flagged) and raise a forgot_submit flag for each. No-ops with a warning if
 * the database is not connected.
 */
export async function sweepUnsubmittedDays(asOfDate: string = siteLocalDate()): Promise<ForgotSubmitSummary> {
  const summary: ForgotSubmitSummary = { scanned: 0, flagged: 0, skipped: 0 };
  if (!db.dbReady) {
    console.warn("Forgot-to-submit sweep skipped: database not connected.");
    return summary;
  }

  const groups = await AttendanceModel.aggregate([
    { $match: { attendanceStatus: "scanned", voided: { $ne: true }, date: { $lt: asOfDate } } },
    { $group: { _id: { siteId: "$siteId", siteName: "$siteName", date: "$date" } } },
  ]);

  for (const g of groups) {
    summary.scanned++;
    try {
      await FlagEventModel.create({
        type: "forgot_submit",
        attemptedSiteId: g._id.siteId,
        attemptedSiteName: g._id.siteName,
        homeSiteId: g._id.siteId,
        homeSiteName: g._id.siteName,
        date: g._id.date,
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
    `Forgot-to-submit sweep (before ${asOfDate}): scanned ${summary.scanned}, flagged ${summary.flagged}, skipped ${summary.skipped}.`,
  );
  return summary;
}
