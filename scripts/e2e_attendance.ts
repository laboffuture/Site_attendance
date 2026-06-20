/* E2E for the Attendance page after manual entry was locked: the daily grid is
   read-only (no type-in fields, no mark form), the manual POST route is gone,
   and the face-scan "Log Attendance" entry is present. Self-contained; cleans
   up. Run: npm run e2e:attendance */

import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { BranchModel, ProjectSiteModel, WorkerModel, UserModel } from "../src/models";

const S = Date.now().toString(36);
const SUP_EMAIL = `qa-att-${S}@trgbi.com`;
const PW = "Pass123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const branch = await BranchModel.create({ name: `QA ATT Branch ${S}` });
  const site = await ProjectSiteModel.create({
    branchId: branch._id, name: `QA ATT Site ${S}`, code: `QAATT${S}`.toUpperCase(),
    standardStartTime: "09:00", standardEndTime: "18:00",
  });
  const worker = await WorkerModel.create({
    empRegNo: `QA-ATT-${S}`, name: `QA Att ${S}`, designationId: new Types.ObjectId(),
    designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active",
  });
  await UserModel.create({
    name: "QA Att Sup", email: SUP_EMAIL, passwordHash: await hashPassword(PW),
    role: "supervisor", assignedSiteIds: [site._id], active: true,
  });

  const sup = request.agent(app);
  assert("supervisor logs in", (await sup.post("/login").type("form").send({ email: SUP_EMAIL, password: PW })).status === 302);

  const grid = await sup.get(`/attendance?siteId=${site._id}`);
  assert("attendance grid 200 + lists the worker", grid.status === 200 && grid.text.includes(`QA-ATT-${S}`));
  assert("grid is read-only — no time inputs", !/name="inTime"/.test(grid.text) && !/name="outTime"/.test(grid.text));
  assert("grid has no manual mark form", !grid.text.includes('action="/attendance/mark"'));
  assert("grid links to Log Attendance (scan)", grid.text.includes("/attendance/scan"));

  // Manual mark route is removed — a crafted POST must not work.
  const mark = await sup.post("/attendance/mark").type("form").send({ workerId: String(worker._id), date: "2026-06-20", inTime: "08:00" });
  assert("POST /attendance/mark is gone (404)", mark.status === 404);
  assert("no record created by the blocked manual post",
    (await mongoose.connection.collection("attendance").countDocuments({ workerId: worker._id })) === 0);

  // The scan entry page renders for the supervisor.
  assert("Log Attendance scan page 200", (await sup.get("/attendance/scan")).status === 200);

  await Promise.all([
    UserModel.deleteOne({ email: SUP_EMAIL }),
    WorkerModel.deleteOne({ _id: worker._id }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E ATTENDANCE FAILED" : "\nE2E ATTENDANCE PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E ATTENDANCE ERROR:", e?.message ?? e); process.exit(1); });
