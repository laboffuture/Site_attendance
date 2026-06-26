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

import { FlagEventModel } from "../models/FlagEvent";

/** Resolve the missed_clockout flag tied to a record once its OUT has been set. */
export async function resolveMissedClockout(attendanceId: Types.ObjectId | string): Promise<void> {
  await FlagEventModel.updateMany(
    { type: "missed_clockout", attendanceId, resolved: false },
    { $set: { resolved: true } },
  );
}

/** Resolve the forgot_submit flag for a site-day once that day has been submitted. */
export async function resolveForgotSubmit(siteId: Types.ObjectId | string, date: string): Promise<void> {
  await FlagEventModel.updateMany(
    { type: "forgot_submit", attemptedSiteId: siteId, date, resolved: false },
    { $set: { resolved: true } },
  );
}
