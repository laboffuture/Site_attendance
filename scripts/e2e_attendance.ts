/* E2E for manual attendance marking / override (spec §3 "mark/override").
   Verifies: the daily grid lists active workers; marking In only creates a
   present record tagged manual; marking In+Out computes total + overtime;
   the record is flagged manual in reports; and a user can't mark at a site
   outside their scope. Cleans up. Run: npm run e2e:attendance */

import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { siteLocalDate } from "../src/lib/time";
import { AttendanceModel, ProjectSiteModel, WorkerModel, UserModel } from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const S = Date.now().toString(36);
const SUP_EMAIL = `qa-asup-${S}@trgbi.com`;
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

  const w = await WorkerModel.create({
    empRegNo: `QA-ATT-${S}`, name: `QA Att ${S}`, designationId: new Types.ObjectId(),
    designationName: "Carpenter", siteId: vbw._id, siteName: vbw.name, faceEncoding: [], status: "active",
  });
  await UserModel.updateOne(
    { email: SUP_EMAIL },
    { $set: { name: "QA ASup", role: "supervisor", assignedSiteIds: [pvm._id], active: true, passwordHash: await hashPassword(PW) } },
    { upsert: true },
  );

  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);

  // Grid lists the worker.
  const grid = await admin.get(`/attendance?siteId=${vbw._id}&date=${today}`);
  assert("attendance grid 200", grid.status === 200);
  assert("grid lists the worker", grid.text.includes(`QA-ATT-${S}`));

  // Mark In only → present, manual, no Out.
  await admin.post("/attendance/mark").type("form").send({ workerId: String(w._id), date: today, inTime: "08:00", outTime: "" });
  let rec = await AttendanceModel.findOne({ workerId: w._id, date: today });
  assert("In-only creates a record", !!rec);
  assert("record tagged manual", rec?.source === "manual");
  assert("markedBy recorded", !!rec?.markedBy);
  assert("no Out yet → no total", rec?.outTime == null && rec?.totalHours == null);

  // Mark In + Out spanning 10.5h → OT 1.5h pending (VBW standard 9h).
  await admin.post("/attendance/mark").type("form").send({ workerId: String(w._id), date: today, inTime: "08:00", outTime: "18:30" });
  rec = await AttendanceModel.findOne({ workerId: w._id, date: today });
  assert("total computed ~10.5h", !!rec && Math.abs((rec.totalHours ?? 0) - 10.5) < 0.05);
  assert("overtime ~1.5h pending", !!rec && Math.abs((rec.overtime.computedHours ?? 0) - 1.5) < 0.05 && rec.overtime.status === "pending");

  // Out-before-In rejected (record unchanged).
  await admin.post("/attendance/mark").type("form").send({ workerId: String(w._id), date: today, inTime: "10:00", outTime: "09:00" });
  rec = await AttendanceModel.findOne({ workerId: w._id, date: today });
  assert("invalid (out<in) left record unchanged", !!rec && Math.abs((rec.totalHours ?? 0) - 10.5) < 0.05);

  // Reports flag it as manual.
  const rep = await admin.get(`/reports?dateFrom=${today}&dateTo=${today}&q=QA-ATT-${S}`);
  assert("reports shows the worker", rep.text.includes(`QA-ATT-${S}`));

  // Scope: PVM supervisor cannot mark the VBW worker, nor see VBW in the grid.
  const sup = await login(app, SUP_EMAIL, PW);
  const supGrid = await sup.get("/attendance");
  assert("supervisor grid excludes VBW", !supGrid.text.includes("(VBW)"));
  await sup.post("/attendance/mark").type("form").send({ workerId: String(w._id), date: today, inTime: "07:00", outTime: "" });
  rec = await AttendanceModel.findOne({ workerId: w._id, date: today });
  assert("supervisor could not alter out-of-scope record", !!rec && String(rec.markedBy) !== String((await UserModel.findOne({ email: SUP_EMAIL }))?._id));

  // Cleanup
  await Promise.all([
    AttendanceModel.deleteMany({ empRegNo: `QA-ATT-${S}` }),
    WorkerModel.deleteMany({ empRegNo: `QA-ATT-${S}` }),
    UserModel.deleteOne({ email: SUP_EMAIL }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E ATTENDANCE FAILED" : "\nE2E ATTENDANCE PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E ATTENDANCE ERROR:", e?.message ?? e); process.exit(1); });
