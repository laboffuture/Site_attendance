/* E2E for the forgot-to-submit sweep: a prior-day site-day still "scanned"
   (never submitted) is flagged exactly once (idempotent); the CURRENT day is
   never flagged. Self-contained; cleans up. Run: npm run e2e:forgot */
import mongoose, { Types } from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { sweepUnsubmittedDays } from "../src/lib/forgotSubmit";
import { resolveForgotSubmit } from "../src/lib/flagResolve";
import { siteLocalDate } from "../src/lib/time";
import { BranchModel, ProjectSiteModel, AttendanceModel, FlagEventModel } from "../src/models";

const S = Date.now().toString(36);
function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const branch = await BranchModel.create({ name: `QA FS ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA FS Site ${S}`, code: `QAFS${S}`.toUpperCase() });
  const rec = (date: string, status: string) => ({
    date, workerId: new Types.ObjectId(), empRegNo: `QA-FS-${S}-${date}`, workerName: `QA FS ${S}`,
    designationId: new Types.ObjectId(), designationName: "Carpenter",
    siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
    inTime: new Date(), source: "scan" as const, attendanceStatus: status,
  });
  const today = siteLocalDate();
  await AttendanceModel.create(rec("2001-05-05", "scanned")); // prior-day, never submitted → should flag
  await AttendanceModel.create(rec(today, "scanned"));        // today, not yet submitted → must NOT flag

  const sum1 = await sweepUnsubmittedDays();
  assert("sweep flags at least one prior-day unsubmitted site-day", sum1.flagged >= 1);
  assert("forgot_submit flag raised for the prior site-day", (await FlagEventModel.countDocuments({ type: "forgot_submit", attemptedSiteId: site._id, date: "2001-05-05" })) === 1);
  assert("today's site-day is NOT flagged (only $lt today)", (await FlagEventModel.countDocuments({ type: "forgot_submit", attemptedSiteId: site._id, date: today })) === 0);

  await sweepUnsubmittedDays(); // idempotent
  assert("re-running does not duplicate the flag", (await FlagEventModel.countDocuments({ type: "forgot_submit", attemptedSiteId: site._id, date: "2001-05-05" })) === 1);

  // resolveForgotSubmit is self-guarding: it must NOT clear the flag while a scanned record remains.
  await resolveForgotSubmit(site._id, "2001-05-05");
  assert("guard: flag stays while a scanned record remains", (await FlagEventModel.countDocuments({ type: "forgot_submit", attemptedSiteId: site._id, date: "2001-05-05", resolved: false })) === 1);
  // Once the day's records leave "scanned" (submitted / corrected / rejected), the flag clears.
  await AttendanceModel.updateMany({ siteId: site._id, date: "2001-05-05" }, { $set: { attendanceStatus: "submitted" } });
  await resolveForgotSubmit(site._id, "2001-05-05");
  assert("forgot_submit auto-resolves once no scanned records remain", (await FlagEventModel.countDocuments({ type: "forgot_submit", attemptedSiteId: site._id, date: "2001-05-05", resolved: true })) === 1);

  await Promise.all([
    FlagEventModel.deleteMany({ attemptedSiteId: site._id }),
    AttendanceModel.deleteMany({ siteId: site._id }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E FORGOT-SUBMIT FAILED" : "\nE2E FORGOT-SUBMIT PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E FORGOT-SUBMIT ERROR:", (e as Error)?.message ?? e); process.exit(1); });
