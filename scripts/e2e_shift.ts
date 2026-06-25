/* E2E for the shift/OT engine via recordScan: an overnight session (In one
   evening, Out next morning) attaches across midnight and computes night OT;
   a fresh scan >20h after a stale open record starts a NEW session. Self-
   contained; cleans up. Run: npm run e2e:shift */
import mongoose, { Types } from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { recordScan } from "../src/lib/attendance";
import { DEFAULT_SHIFTS } from "../src/lib/shift";
import { BranchModel, ProjectSiteModel, AttendanceModel } from "../src/models";

const S = Date.now().toString(36);
function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
const near = (a: number | null, b: number) => a != null && Math.abs(a - b) < 0.05;

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const branch = await BranchModel.create({ name: `QA SHIFT ${S}` });
  const site = await ProjectSiteModel.create({
    branchId: branch._id, name: `QA Shift Site ${S}`, code: `QASH${S}`.toUpperCase(),
    standardStartTime: "08:00", standardEndTime: "17:00", shifts: DEFAULT_SHIFTS,
  });
  const siteArg = { _id: site._id, name: site.name, branchId: branch._id, shifts: DEFAULT_SHIFTS };
  const worker = { _id: new Types.ObjectId(), empRegNo: `QA-SH-${S}`, name: `QA Sh ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter" };

  // First scan → IN (no open session yet)
  const r1 = await recordScan(worker, siteArg as never, branch.name);
  assert("first scan → in", r1.action === "in");
  const rec = await AttendanceModel.findOne({ workerId: worker._id, outTime: null });
  assert("open record created with a shiftType", !!rec && !!rec.shiftType);

  // Simulate a night shift: backdate the In to 11h ago and tag it night, so the
  // Out (now) lands beyond the 9h window → ~2h OT (2 <= 5 threshold → no break).
  const inAt = new Date(Date.now() - 11 * 3_600_000);
  await AttendanceModel.updateOne({ _id: rec!._id }, { $set: { inTime: inAt, shiftType: "night" } });

  // Second scan → OUT, attaches to the open session across the gap
  const r2 = await recordScan(worker, siteArg as never, branch.name);
  assert("second scan → out (session matched)", r2.action === "out");
  assert("total ~11h", near(r2.totalHours, 11));
  assert("night OT ~2h, no break (2<5)", near(r2.overtimeHours, 2) && r2.overtimeStatus === "pending");
  const closed = await AttendanceModel.findById(rec!._id);
  assert("record closed with outTime + breakHours set", !!closed && !!closed.outTime && closed.breakHours != null);

  // A stale open record >20h old must NOT capture a new scan. Use a FRESH
  // worker (no record today) so this isolates the 20h-lookback boundary.
  const worker2 = { _id: new Types.ObjectId(), empRegNo: `QA-SH2-${S}`, name: `QA Sh2 ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter" };
  await AttendanceModel.create({
    date: "2000-01-01", workerId: worker2._id, empRegNo: worker2.empRegNo, workerName: worker2.name,
    designationId: worker2.designationId, designationName: "Carpenter",
    siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
    inTime: new Date(Date.now() - 30 * 3_600_000), shiftType: "day", source: "scan",
  });
  const r3 = await recordScan(worker2, siteArg as never, branch.name);
  assert("scan >20h after a stale open record → new in (not out)", r3.action === "in");

  // Same-day re-scan AFTER a session closed → toggles back to IN (punch-clock:
  // worker went out and came back). First In stays; the next scan is the Out.
  const r4 = await recordScan(worker, siteArg as never, branch.name);
  assert("same-day re-scan after close → in (re-open / coming back)", r4.action === "in");
  const r5 = await recordScan(worker, siteArg as never, branch.name);
  assert("scan after re-open → out again (last Out wins)", r5.action === "out");

  await Promise.all([
    AttendanceModel.deleteMany({ workerId: { $in: [worker._id, worker2._id] } }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E SHIFT FAILED" : "\nE2E SHIFT PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E SHIFT ERROR:", e?.message ?? e); process.exit(1); });
