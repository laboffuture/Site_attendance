/* Close-the-loop flag resolution.
 *
 * A flag is a symptom of a broken record; when the record is genuinely fixed the
 * flag should clear itself. These helpers are called from every place that fixes
 * the underlying issue (a scan OUT, an HR correction, a supervisor submit, or the
 * inline fix on the /flags queue) so the queue always reflects reality instead of
 * lingering after the work is done. Both are idempotent no-ops when no open flag
 * matches, so they are safe to call unconditionally.
 */
import { Types } from "mongoose";

import { AttendanceModel } from "../models/Attendance";
import { FlagEventModel } from "../models/FlagEvent";

/** Resolve the missed_clockout flag tied to a record once its OUT has been set. */
export async function resolveMissedClockout(attendanceId: Types.ObjectId | string): Promise<void> {
  await FlagEventModel.updateMany(
    { type: "missed_clockout", attendanceId, resolved: false },
    { $set: { resolved: true } },
  );
}

/** Resolve the forgot_submit flag for a site-day — but only once NO un-submitted
 *  (scanned) records remain for it. The flag means "this day still has scanned
 *  records"; a single correction on a partly-submitted day must not clear it early.
 *  Self-guarding, so it is safe to call from any route that moves a record out of
 *  "scanned" (full submit, inline submit-day, an HR correction, or a reject). */
export async function resolveForgotSubmit(siteId: Types.ObjectId | string, date: string): Promise<void> {
  const remaining = await AttendanceModel.countDocuments({ siteId, date, attendanceStatus: "scanned", voided: { $ne: true } });
  if (remaining > 0) return; // day still partly un-submitted — keep the flag
  await FlagEventModel.updateMany(
    { type: "forgot_submit", attemptedSiteId: siteId, date, resolved: false },
    { $set: { resolved: true } },
  );
}
