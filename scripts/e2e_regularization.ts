/* E2E for the daily attendance regularization chain: supervisor submits the
   day (+remarks) → PM recommends → HR approves (OT approved too); per-worker
   reject excludes one. Self-contained; cleans up. Run: npm run e2e:regularization */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { siteLocalDate } from "../src/lib/time";
import { BranchModel, ProjectSiteModel, WorkerModel, UserModel, AttendanceModel } from "../src/models";

const S = Date.now().toString(36);
const PW = "Pass123!";
const today = siteLocalDate();

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
async function login(app: ReturnType<typeof createApp>, email: string) {
  const a = request.agent(app);
  const r = await a.post("/login").type("form").send({ email, password: PW });
  if (r.status !== 302) throw new Error(`login failed ${email}`);
  return a;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const branch = await BranchModel.create({ name: `QA REG ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA Reg Site ${S}`, code: `QAREG${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const desig = new Types.ObjectId();
  async function worker(reg: string, otH: number) {
    const w = await WorkerModel.create({ empRegNo: reg, name: `W ${reg}`, designationId: desig, designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active" });
    await AttendanceModel.create({
      date: today, workerId: w._id, empRegNo: reg, workerName: w.name, designationId: desig, designationName: "Carpenter",
      siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
      inTime: new Date(Date.now() - 9 * 3_600_000), outTime: new Date(), totalHours: 9, standardHours: 8,
      overtime: { computedHours: otH, status: otH > 0 ? "pending" : "none" }, source: "scan",
    });
    return w;
  }
  const wa = await worker(`QA-RG-A-${S}`, 2); // has OT
  const wb = await worker(`QA-RG-B-${S}`, 0); // no OT

  const sup = `qa-rgsup-${S}@trgbi.com`, pm = `qa-rgpm-${S}@trgbi.com`, hr = `qa-rghr-${S}@trgbi.com`;
  await UserModel.create({ name: "RG Sup", email: sup, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [site._id], active: true });
  await UserModel.create({ name: "RG PM", email: pm, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [site._id], active: true });
  await UserModel.create({ name: "RG HR", email: hr, passwordHash: await hashPassword(PW), role: "hr", assignedSiteIds: [], active: true });

  // --- Supervisor submits the day with remarks ---
  const sa = await login(app, sup);
  const form = await sa.get(`/attendance/submit?siteId=${site._id}&date=${today}`);
  assert("submit screen lists the workers", form.text.includes(`QA-RG-A-${S}`) && form.text.includes(`QA-RG-B-${S}`));
  const submit = await sa.post("/attendance/submit").type("form").send({ siteId: String(site._id), date: today, [`remark_${wa._id}`]: "Tiling done", [`remark_${wb._id}`]: "Helper" });
  assert("submit redirects", submit.status === 302);
  const recA = await AttendanceModel.findOne({ workerId: wa._id, date: today });
  assert("records flipped to submitted with remark + audit", recA?.attendanceStatus === "submitted" && recA?.dailyRemark === "Tiling done" && !!recA?.submittedBy);

  // --- PM recommends the day ---
  const pa = await login(app, pm);
  assert("PM sees the submitted day", (await pa.get("/regularization")).text.includes(`QA Reg Site ${S}`));
  await pa.post(`/regularization/${site._id}/${today}/recommend`).type("form").send({});
  assert("day recommended", (await AttendanceModel.findOne({ workerId: wa._id, date: today }))?.attendanceStatus === "recommended");

  // --- per-worker reject (B) then HR approve the day ---
  const ha = await login(app, hr);
  const rb = await AttendanceModel.findOne({ workerId: wb._id, date: today });
  await ha.post(`/regularization/worker/${rb!._id}/reject`).type("form").send({ reason: "absent disputed" });
  assert("worker B rejected", (await AttendanceModel.findById(rb!._id))?.attendanceStatus === "rejected");
  await ha.post(`/regularization/${site._id}/${today}/approve`).type("form").send({});
  const fa = await AttendanceModel.findOne({ workerId: wa._id, date: today });
  assert("worker A approved", fa?.attendanceStatus === "approved");
  assert("worker A OT approved (subsumed)", fa?.overtime.status === "approved");
  assert("rejected worker B stays rejected after approve", (await AttendanceModel.findById(rb!._id))?.attendanceStatus === "rejected");

  // scope: a PM at another site can't recommend this day
  const pm2 = `qa-rgpm2-${S}@trgbi.com`;
  const otherSite = await ProjectSiteModel.create({ branchId: branch._id, name: `QA Reg Other ${S}`, code: `QARGO${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  await UserModel.create({ name: "RG PM2", email: pm2, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [otherSite._id], active: true });
  const p2 = await login(app, pm2);
  const blocked = await p2.post(`/regularization/${site._id}/${today}/recommend`).type("form").send({});
  assert("out-of-scope PM cannot act on the day", blocked.status === 403 || blocked.status === 302);

  // Cleanup
  await Promise.all([
    AttendanceModel.deleteMany({ siteId: { $in: [site._id, otherSite._id] } }),
    WorkerModel.deleteMany({ siteId: site._id }),
    UserModel.deleteMany({ email: { $in: [sup, pm, hr, pm2] } }),
    ProjectSiteModel.deleteMany({ _id: { $in: [site._id, otherSite._id] } }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E REGULARIZATION FAILED" : "\nE2E REGULARIZATION PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E REGULARIZATION ERROR:", e?.message ?? e); process.exit(1); });
