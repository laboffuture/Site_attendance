/* E2E: HR-only attendance corrections (fill a missing OUT, void a bogus record)
   with audit; the day then re-enters the approval chain for Management. Non-HR
   is blocked. Self-contained; cleans up. Run: npm run e2e:correction */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { istDateTime, siteLocalDate } from "../src/lib/time";
import { BranchModel, ProjectSiteModel, WorkerModel, AttendanceModel, UserModel } from "../src/models";

const S = Date.now().toString(36);
const HR_EMAIL = `qa-corr-hr-${S}@trgbi.com`;
const MGMT_EMAIL = `qa-corr-mgmt-${S}@trgbi.com`;
const PW = "Pass123!";
const today = siteLocalDate();

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
async function login(app: ReturnType<typeof createApp>, email: string) {
  const agent = request.agent(app);
  const r = await agent.post("/login").type("form").send({ email, password: PW });
  if (r.status !== 302) throw new Error(`login failed ${email} (${r.status})`);
  return agent;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const branch = await BranchModel.create({ name: `QA CORR ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA CORR Site ${S}`, code: `QACORR${S}`.toUpperCase(), lunchHours: 1 });
  const worker = await WorkerModel.create({ empRegNo: `QA-CR-${S}`, name: `QA Corr ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active", dailyWage: 800 });
  await UserModel.create({ name: "QA Corr HR", email: HR_EMAIL, passwordHash: await hashPassword(PW), role: "hr", assignedSiteIds: [], active: true });
  await UserModel.create({ name: "QA Corr Mgmt", email: MGMT_EMAIL, passwordHash: await hashPassword(PW), role: "management", assignedSiteIds: [], active: true });

  const base = { date: today, empRegNo: worker.empRegNo, workerName: worker.name, designationId: worker.designationId, designationName: "Carpenter", siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name, source: "scan" as const, shiftType: "day" as const };
  // An OPEN record (IN 08:00 today, no OUT) — HR fills the OUT.
  const openRec = await AttendanceModel.create({ ...base, workerId: worker._id, inTime: istDateTime(today, "08:00"), outTime: null });
  // A bogus 5-minute record (different worker, same day) — HR voids it.
  const bogusRec = await AttendanceModel.create({ ...base, workerId: new Types.ObjectId(), empRegNo: `QA-CR2-${S}`, inTime: istDateTime(today, "09:00"), outTime: istDateTime(today, "09:05"), totalHours: 0.08 });

  const hr = await login(app, HR_EMAIL);

  // HR fills the missing OUT (08:00 → 17:00, lunch 1h → 8h std, 0 OT).
  const fix = await hr.post(`/regularization/worker/${openRec._id}/correct`).type("form").send({ outHM: "17:00", reason: "Worker forgot to scan out" });
  assert("HR correction redirects (success)", fix.status === 302);
  const fixed = await AttendanceModel.findById(openRec._id);
  assert("OUT filled by HR", !!fixed!.outTime);
  assert("outSource = hr-filled", fixed!.outSource === "hr-filled");
  assert("hours recomputed (9h span, 8 std, 0 OT)", fixed!.totalHours === 9 && fixed!.standardHours === 8 && (fixed!.overtime?.computedHours ?? -1) === 0);
  assert("audit entry written for outTime", fixed!.corrections.length === 1 && fixed!.corrections[0].field === "outTime");
  assert("day moved to recommended (Management approves next)", fixed!.attendanceStatus === "recommended");
  assert("record marked manual + markedBy set", fixed!.source === "manual" && !!fixed!.markedBy);

  // HR voids the bogus record.
  const voidRes = await hr.post(`/regularization/worker/${bogusRec._id}/void`).type("form").send({ reason: "accidental double scan" });
  assert("HR void redirects (success)", voidRes.status === 302);
  const voided = await AttendanceModel.findById(bogusRec._id);
  assert("record voided + reason", voided!.voided === true && voided!.voidReason === "accidental double scan");

  // HR creates a manual day for a worker who never scanned (08:00–17:00, lunch 1h → 8h, 0 OT).
  const w2 = await WorkerModel.create({ empRegNo: `QA-CR3-${S}`, name: `QA NoScan ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active" });
  // The day page now offers w2 (no record yet) in the HR add-worker form.
  const dayPage = await hr.get(`/regularization/${site._id}/${today}`);
  assert("day page renders the HR add-worker form with the eligible worker", dayPage.status === 200 && dayPage.text.includes("Add a worker who didn't scan") && dayPage.text.includes(`QA NoScan ${S}`));
  const created = await hr.post(`/regularization/${site._id}/${today}/create`).type("form").send({ workerId: String(w2._id), inHM: "08:00", outHM: "17:00", shiftType: "day", reason: "Scanner was down" });
  assert("HR create-day redirects (success)", created.status === 302);
  const newRec = await AttendanceModel.findOne({ workerId: w2._id, date: today });
  assert("manual day created (manual source, recommended)", !!newRec && newRec.source === "manual" && newRec.attendanceStatus === "recommended");
  assert("manual day hours computed (9h span → 8 std, 0 OT)", newRec!.totalHours === 9 && newRec!.standardHours === 8 && (newRec!.overtime?.computedHours ?? -1) === 0);
  assert("manual day audited (create entry)", (newRec!.corrections?.length ?? 0) >= 1 && newRec!.corrections.some((c) => c.field === "create"));

  // Management can now use the full correction editor too (Management + HR).
  const mgmt = await login(app, MGMT_EMAIL);
  const mgmtFix = await mgmt.post(`/regularization/worker/${openRec._id}/correct`).type("form").send({ outHM: "18:00", reason: "Mgmt close-out" });
  assert("Management can correct attendance (302, not 403)", mgmtFix.status === 302);
  assert("Management's correction set the OUT", (await AttendanceModel.findById(openRec._id).lean())!.outTime != null);

  await Promise.all([
    AttendanceModel.deleteMany({ siteId: site._id }),
    WorkerModel.deleteMany({ siteId: site._id }),
    UserModel.deleteMany({ email: { $in: [HR_EMAIL, MGMT_EMAIL] } }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E CORRECTION FAILED" : "\nE2E CORRECTION PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E CORRECTION ERROR:", e?.message ?? e); process.exit(1); });
