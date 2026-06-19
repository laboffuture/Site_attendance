/* E2E for the Requests subsystem (scheduled OT + offload).
   Flow: Supervisor/PM create → PM recommends → admin approves/rejects.
   Verifies: create; admin cannot approve before PM recommends (mandatory);
   recommend then approve; reject path; offload approval deactivates the worker;
   there is NO withdraw route; scope (supervisor only sees own-site requests).
   Cleans up. Run: npm run e2e:requests */

import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { ProjectSiteModel, WorkerModel, UserModel, RequestModel } from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const S = Date.now().toString(36);
const PM_EMAIL = `qa-rqpm-${S}@trgbi.com`;
const SUP_EMAIL = `qa-rqsup-${S}@trgbi.com`;
const PW = "Pass123!";

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
    empRegNo: `RQ-${S}`, name: `QA Req ${S}`, designationId: new Types.ObjectId(),
    designationName: "Carpenter", siteId: vbw._id, siteName: vbw.name, faceEncoding: [], status: "active",
  });
  const wPvm = await WorkerModel.create({
    empRegNo: `RQP-${S}`, name: `QA ReqP ${S}`, designationId: new Types.ObjectId(),
    designationName: "Mason", siteId: pvm._id, siteName: pvm.name, faceEncoding: [], status: "active",
  });
  await UserModel.create({ name: "QA ReqPM", email: PM_EMAIL, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [vbw._id], active: true });
  await UserModel.create({ name: "QA ReqSup", email: SUP_EMAIL, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [vbw._id], active: true });

  const sup = await login(app, SUP_EMAIL, PW);
  const pm = await login(app, PM_EMAIL, PW);
  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);

  // Supervisor creates a scheduled-OT request.
  await sup.post("/requests").type("form").send({
    type: "scheduled_ot", workerId: String(w._id), date: "2026-07-01", fromTime: "18:00", toTime: "21:00", requesterRemarks: "Pour deadline",
  });
  const ot = await RequestModel.findOne({ workerId: w._id, type: "scheduled_ot" });
  assert("scheduled OT request created (pending)", !!ot && ot.status === "pending");
  assert("OT hours computed (3h)", !!ot && ot.hours === 3);

  // Admin CANNOT approve before PM recommends (mandatory step).
  await admin.post(`/requests/${ot!._id}/approve`).type("form").send({});
  assert("admin cannot approve a pending (un-recommended) request", (await RequestModel.findById(ot!._id))!.status === "pending");

  // PM recommends → admin approves.
  await pm.post(`/requests/${ot!._id}/recommend`).type("form").send({ remarks: "ok" });
  assert("PM recommend → recommended", (await RequestModel.findById(ot!._id))!.status === "recommended");
  await admin.post(`/requests/${ot!._id}/approve`).type("form").send({ remarks: "approved" });
  const otFinal = await RequestModel.findById(ot!._id);
  assert("admin approve → approved", otFinal!.status === "approved");
  assert("approver recorded", !!otFinal!.decidedByName);

  // No withdraw route exists.
  const withdraw = await sup.post(`/requests/${ot!._id}/withdraw`).type("form").send({});
  assert("no withdraw route (404)", withdraw.status === 404);

  // Offload: supervisor suggests (reason required); reject path then a fresh one approved.
  await sup.post("/requests").type("form").send({ type: "offload", workerId: String(w._id) }); // no remark
  assert("offload without reason rejected", (await RequestModel.countDocuments({ workerId: w._id, type: "offload" })) === 0);
  await sup.post("/requests").type("form").send({ type: "offload", workerId: String(w._id), requesterRemarks: "left site" });
  const off = await RequestModel.findOne({ workerId: w._id, type: "offload" });
  assert("offload suggestion created", !!off && off.status === "pending");
  await pm.post(`/requests/${off!._id}/recommend`).type("form").send({});
  await admin.post(`/requests/${off!._id}/approve`).type("form").send({});
  assert("offload approved", (await RequestModel.findById(off!._id))!.status === "approved");
  assert("offload approval deactivated the worker", (await WorkerModel.findById(w._id))!.status === "inactive");

  // Scope: supervisor cannot create a request for a worker outside their sites.
  await sup.post("/requests").type("form").send({ type: "offload", workerId: String(wPvm._id), requesterRemarks: "x" });
  assert("supervisor blocked from other-site worker", (await RequestModel.countDocuments({ workerId: wPvm._id })) === 0);
  // ...and their list excludes other-site requests (none here) but shows own.
  const supList = await sup.get("/requests?tab=all");
  assert("supervisor list shows own-site request", supList.text.includes(`RQ-${S}`));

  // Cleanup.
  await Promise.all([
    RequestModel.deleteMany({ empRegNo: { $in: [`RQ-${S}`, `RQP-${S}`] } }),
    WorkerModel.deleteMany({ empRegNo: { $in: [`RQ-${S}`, `RQP-${S}`] } }),
    UserModel.deleteMany({ email: { $in: [PM_EMAIL, SUP_EMAIL] } }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E REQUESTS FAILED" : "\nE2E REQUESTS PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E REQUESTS ERROR:", e?.message ?? e); process.exit(1); });
