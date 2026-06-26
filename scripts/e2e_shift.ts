/* E2E for the EXPLICIT-action scan engine (recordScan with action "in"|"out").
   Covers: explicit IN/OUT, already_in (no dup), not_clocked_in, reopen/come-back,
   a real 24h shift closing on explicit OUT, and the Teja fix — a prior-day open
   record + IN today => a NEW IN, yesterday left untouched. Self-contained; cleans
   up. Run: npm run e2e:shift */
import mongoose, { Types } from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { recordScan } from "../src/lib/attendance";
import { DEFAULT_SHIFTS } from "../src/lib/shift";
import { siteLocalDate } from "../src/lib/time";
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
  const today = siteLocalDate();
  const worker = { _id: new Types.ObjectId(), empRegNo: `QA-SH-${S}`, name: `QA Sh ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter" };

  // Explicit IN
  const r1 = await recordScan(worker, siteArg as never, branch.name, "in");
  assert("explicit IN → outcome in", r1.outcome === "in");
  const rec = await AttendanceModel.findOne({ workerId: worker._id, date: today });
  assert("open record created with a shiftType", !!rec && !!rec.shiftType && rec.outTime == null);

  // IN again while already open → already_in (no duplicate)
  const rDup = await recordScan(worker, siteArg as never, branch.name, "in");
  assert("IN while already in → already_in", rDup.outcome === "already_in");
  assert("no duplicate record created", (await AttendanceModel.countDocuments({ workerId: worker._id, date: today })) === 1);

  // Backdate the In 11h + tag night, then explicit OUT closes it.
  await AttendanceModel.updateOne({ _id: rec!._id }, { $set: { inTime: new Date(Date.now() - 11 * 3_600_000), shiftType: "night" } });
  const r2 = await recordScan(worker, siteArg as never, branch.name, "out");
  assert("explicit OUT → out, ~11h total, ~2h OT pending", r2.outcome === "out" && near(r2.totalHours, 11) && near(r2.overtimeHours, 2) && r2.overtimeStatus === "pending");
  const closed = await AttendanceModel.findById(rec!._id);
  assert("closed: outTime + breakHours set, outSource=scanned", !!closed!.outTime && closed!.breakHours != null && closed!.outSource === "scanned");

  // OUT again when not clocked in (closed, beyond debounce) → not_clocked_in (no change).
  await AttendanceModel.updateOne({ _id: rec!._id }, { $set: { outTime: new Date(Date.now() - 120_000) } });
  const r3 = await recordScan(worker, siteArg as never, branch.name, "out");
  assert("OUT when not clocked in → not_clocked_in", r3.outcome === "not_clocked_in");

  // Come back: explicit IN re-opens (first-In stays), then OUT closes again.
  const r4 = await recordScan(worker, siteArg as never, branch.name, "in");
  assert("IN after close → reopen (outcome in)", r4.outcome === "in");
  const reopened = await AttendanceModel.findById(rec!._id);
  assert("reopen clears breakHours + outSource", reopened!.breakHours == null && reopened!.outSource == null);
  const r5 = await recordScan(worker, siteArg as never, branch.name, "out");
  assert("OUT after reopen → out", r5.outcome === "out");
  const finalRec = await AttendanceModel.findById(rec!._id);
  assert("sessions log: 2 punch pairs, both closed", (finalRec!.sessions?.length ?? 0) === 2 && finalRec!.sessions[0].outTime != null && finalRec!.sessions[1].outTime != null);

  // A real ~24h shift: IN backdated 24h, explicit OUT still closes it.
  const wLong = { _id: new Types.ObjectId(), empRegNo: `QA-LONG-${S}`, name: `QA Long ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter" };
  await recordScan(wLong, siteArg as never, branch.name, "in");
  await AttendanceModel.updateOne({ workerId: wLong._id, outTime: null }, { $set: { inTime: new Date(Date.now() - 24 * 3_600_000) } });
  const rLong = await recordScan(wLong, siteArg as never, branch.name, "out");
  assert("24h-old open + explicit OUT → out (closes the long shift)", rLong.outcome === "out");

  // THE TEJA FIX: a prior-day OPEN record + explicit IN today → a NEW IN; yesterday untouched.
  const teja = { _id: new Types.ObjectId(), empRegNo: `QA-TEJA-${S}`, name: `QA Teja ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter" };
  const yest = await AttendanceModel.create({
    date: "2000-01-02", workerId: teja._id, empRegNo: teja.empRegNo, workerName: teja.name,
    designationId: teja.designationId, designationName: "Carpenter",
    siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
    inTime: new Date(Date.now() - 24 * 3_600_000), outTime: null, source: "scan",
  });
  const rTeja = await recordScan(teja, siteArg as never, branch.name, "in");
  assert("Teja IN today → new IN (not yesterday's OUT)", rTeja.outcome === "in" && rTeja.date === today);
  const yestAfter = await AttendanceModel.findById(yest._id).lean();
  assert("Teja's prior-day open record is UNTOUCHED (still open)", yestAfter!.outTime == null);
  assert("Teja now has 2 records (yesterday + a fresh today)", (await AttendanceModel.countDocuments({ workerId: teja._id })) === 2);

  await Promise.all([
    AttendanceModel.deleteMany({ workerId: { $in: [worker._id, wLong._id, teja._id] } }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E SHIFT FAILED" : "\nE2E SHIFT PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E SHIFT ERROR:", e?.message ?? e); process.exit(1); });
