/* E2E for the missed clock-out sweep (flag-only, idempotent).
   Verifies: an open In-only record raises exactly one missed_clockout flag
   and leaves the attendance record unchanged; a completed record is never
   flagged; running the sweep twice does not duplicate the flag; and the flag
   is role-scoped on /flags (visible to admin, hidden from an off-site
   supervisor). Cleans up its data. Run: npm run e2e:missed */

import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { sweepMissedClockouts } from "../src/lib/missedClockout";
import { siteLocalDate } from "../src/lib/time";
import { AttendanceModel, FlagEventModel, ProjectSiteModel, WorkerModel, UserModel } from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const S = Date.now().toString(36);
const SUP_EMAIL = `qa-msup-${S}@trgbi.com`;
const PW = "Pass123!";
const today = siteLocalDate();

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
async function login(app: ReturnType<typeof createApp>, email: string, pw: string) {
  const agent = request.agent(app);
  const r = await agent.post("/login").type("form").send({ email, password: pw });
  if (r.status !== 302) throw new Error(`login failed ${email}`);
  return agent;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  const pvm = await ProjectSiteModel.findOne({ code: "PVM" });
  if (!vbw || !pvm) throw new Error("Run npm run seed first.");

  // An open record (In scanned, never Out) at VBW today.
  const openWorker = await WorkerModel.create({
    empRegNo: `QA-MO-${S}`, name: `QA MissedOut ${S}`, designationId: new Types.ObjectId(),
    designationName: "Carpenter", siteId: vbw._id, siteName: vbw.name, faceEncoding: [], status: "active",
  });
  const openRec = await AttendanceModel.create({
    date: today, workerId: openWorker._id, empRegNo: openWorker.empRegNo, workerName: openWorker.name,
    designationId: openWorker.designationId, designationName: "Carpenter",
    siteId: vbw._id, siteName: vbw.name, branchId: vbw.branchId, branchName: "QA",
    inTime: new Date(Date.now() - 8 * 3_600_000), outTime: null, source: "scan",
  });

  // A completed record (has Out) at VBW today — must never be flagged.
  const doneWorker = await WorkerModel.create({
    empRegNo: `QA-MD-${S}`, name: `QA Done ${S}`, designationId: new Types.ObjectId(),
    designationName: "Carpenter", siteId: vbw._id, siteName: vbw.name, faceEncoding: [], status: "active",
  });
  const doneRec = await AttendanceModel.create({
    date: today, workerId: doneWorker._id, empRegNo: doneWorker.empRegNo, workerName: doneWorker.name,
    designationId: doneWorker.designationId, designationName: "Carpenter",
    siteId: vbw._id, siteName: vbw.name, branchId: vbw.branchId, branchName: "QA",
    inTime: new Date(Date.now() - 8 * 3_600_000), outTime: new Date(), totalHours: 8, standardHours: 9, source: "scan",
  });

  // Off-site supervisor (assigned to PVM, not VBW).
  await UserModel.updateOne(
    { email: SUP_EMAIL },
    { $set: { name: "QA MSup", role: "supervisor", assignedSiteIds: [pvm._id], active: true, passwordHash: await hashPassword(PW) } },
    { upsert: true },
  );

  // --- First sweep ---
  const sum1 = await sweepMissedClockouts();
  assert("sweep reports at least one flagged", sum1.flagged >= 1);
  assert("open record flagged exactly once",
    (await FlagEventModel.countDocuments({ type: "missed_clockout", attendanceId: openRec._id })) === 1);
  assert("completed record not flagged",
    (await FlagEventModel.countDocuments({ type: "missed_clockout", attendanceId: doneRec._id })) === 0);

  const afterSweep = await AttendanceModel.findById(openRec._id);
  assert("attendance record left unchanged (still open)",
    !!afterSweep && afterSweep.outTime == null && afterSweep.totalHours == null);

  // --- Second sweep (idempotency) ---
  await sweepMissedClockouts();
  assert("re-running does not duplicate the flag",
    (await FlagEventModel.countDocuments({ type: "missed_clockout", attendanceId: openRec._id })) === 1);

  // --- Role scoping on /flags ---
  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);
  const adminFlags = await admin.get("/flags");
  assert("admin sees the missed-clockout flag", adminFlags.text.includes(openWorker.name));

  const sup = await login(app, SUP_EMAIL, PW);
  const supFlags = await sup.get("/flags");
  assert("off-site supervisor does not see the flag", !supFlags.text.includes(openWorker.name));

  // Cleanup
  await Promise.all([
    FlagEventModel.deleteMany({ attendanceId: { $in: [openRec._id, doneRec._id] } }),
    AttendanceModel.deleteMany({ empRegNo: { $in: [`QA-MO-${S}`, `QA-MD-${S}`] } }),
    WorkerModel.deleteMany({ empRegNo: { $in: [`QA-MO-${S}`, `QA-MD-${S}`] } }),
    UserModel.deleteOne({ email: SUP_EMAIL }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E MISSED-CLOCKOUT FAILED" : "\nE2E MISSED-CLOCKOUT PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E MISSED-CLOCKOUT ERROR:", e?.message ?? e); process.exit(1); });
