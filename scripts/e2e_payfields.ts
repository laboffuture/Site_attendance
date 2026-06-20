/* E2E: pay fields (daily wage + food allowance) persist on enrol and edit.
   Self-contained; cleans up. Run: npm run e2e:payfields */

import fs from "fs";
import path from "path";

import request from "supertest";
import mongoose from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { config } from "../src/config";
import { BranchModel, ProjectSiteModel, DesignationModel, WorkerModel, UserModel } from "../src/models";

const FIXTURE = path.join(process.cwd(), "test/fixtures/face_single.jpg");
const S = Date.now().toString(36);
const ADMIN = `qa-pay-${S}@trgbi.com`;
const PW = "Pass123!";
const EMPID = `QA-PAY-${S}`.toUpperCase();

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
function faceUrl(): string {
  return "data:image/jpeg;base64," + fs.readFileSync(FIXTURE).toString("base64");
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const branch = await BranchModel.create({ name: `QA PAY Branch ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA PAY Site ${S}`, code: `QAPAY${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const desig = await DesignationModel.findOneAndUpdate({ name: "Carpenter" }, { $setOnInsert: { name: "Carpenter" } }, { upsert: true, new: true });
  // top admin so site scope is unrestricted
  await UserModel.create({ name: "QA Pay Admin", email: ADMIN, passwordHash: await hashPassword(PW), role: "management", assignedSiteIds: [], active: true });

  const agent = request.agent(app);
  assert("admin logs in", (await agent.post("/login").type("form").send({ email: ADMIN, password: PW })).status === 302);

  // enrol with pay fields
  await agent.post("/workers").type("form").send({
    empRegNo: EMPID, name: `QA Pay ${S}`, designationId: String(desig!._id), siteId: String(site._id),
    dailyWage: "750", foodAllowanceApplicable: "on", foodAllowanceAmount: "120",
    photoData: faceUrl(),
  });
  let w = await WorkerModel.findOne({ empRegNo: EMPID });
  assert("worker created", !!w);
  assert("daily wage stored", w?.dailyWage === 750);
  assert("food allowance applicable + amount stored", !!w?.foodAllowance && w.foodAllowance.applicable === true && w.foodAllowance.amount === 120);

  // edit: raise wage, turn food allowance off
  await agent.post(`/workers/${w!._id}`).type("form").send({
    name: w!.name, designationId: String(desig!._id), siteId: String(site._id), status: "active",
    dailyWage: "800",
  });
  w = await WorkerModel.findOne({ empRegNo: EMPID });
  assert("daily wage updated on edit", w?.dailyWage === 800);
  assert("food allowance cleared when unchecked", !!w?.foodAllowance && w.foodAllowance.applicable === false && w.foodAllowance.amount == null);

  // enrol form exposes the pay inputs
  const form = await agent.get("/workers/new");
  assert("enrol form shows pay fields", form.text.includes('name="dailyWage"') && form.text.includes('name="foodAllowanceAmount"'));

  // Cleanup
  try { fs.unlinkSync(path.join(config.uploadDir, `${w!._id}.jpg`)); } catch { /* ignore */ }
  await Promise.all([
    UserModel.deleteOne({ email: ADMIN }),
    WorkerModel.deleteOne({ empRegNo: EMPID }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E PAYFIELDS FAILED" : "\nE2E PAYFIELDS PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E PAYFIELDS ERROR:", e?.message ?? e); process.exit(1); });
