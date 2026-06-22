/* E2E for Management role-tuning: Management verifies/approves but does NOT log
   or submit attendance, and raises Offload suggestions only (no Scheduled-OT) —
   while still approving requests from below. Self-contained; cleans up.
   Run: npm run e2e:management */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { BranchModel, ProjectSiteModel, WorkerModel, UserModel, RequestModel } from "../src/models";

const S = Date.now().toString(36);
const PW = "Pass123!";
function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
async function login(app: ReturnType<typeof createApp>, email: string) {
  const a = request.agent(app);
  const r = await a.post("/login").type("form").send({ email, password: PW });
  if (r.status !== 302) throw new Error(`login failed ${email} (${r.status})`);
  return a;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const branch = await BranchModel.create({ name: `QA MG ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA MG Site ${S}`, code: `QAMG${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const w = await WorkerModel.create({ empRegNo: `QA-MG-${S}`, name: `W ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active" });

  const mgmt = `qa-mg-${S}@trgbi.com`, sup = `qa-mgsup-${S}@trgbi.com`;
  await UserModel.create({ name: "QA Mgmt", email: mgmt, passwordHash: await hashPassword(PW), role: "management", assignedSiteIds: [], active: true });
  await UserModel.create({ name: "QA MGSup", email: sup, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [site._id], active: true });

  const ma = await login(app, mgmt);

  // Management does NOT log or submit attendance.
  assert("management GET /attendance → 403", (await ma.get("/attendance")).status === 403);
  assert("management GET /attendance/submit → 403", (await ma.get("/attendance/submit")).status === 403);

  // Requests: Scheduled-OT is hidden + blocked for Management.
  const form = await ma.get("/requests/new?type=scheduled_ot");
  assert("management new-request hides the Scheduled-OT tab", form.status === 200 && !form.text.includes("?type=scheduled_ot"));
  await ma.post("/requests").type("form").send({ type: "scheduled_ot", workerId: String(w._id), date: "2026-07-01", fromTime: "18:00", toTime: "21:00" });
  assert("management cannot create a Scheduled-OT request", (await RequestModel.countDocuments({ workerId: w._id, type: "scheduled_ot" })) === 0);

  // ...but CAN suggest an Offload.
  await ma.post("/requests").type("form").send({ type: "offload", workerId: String(w._id), requesterRemarks: "left site" });
  assert("management can suggest an Offload", (await RequestModel.countDocuments({ workerId: w._id, type: "offload" })) === 1);

  // Management approves a request that comes from below.
  const sa = await login(app, sup);
  await sa.post("/requests").type("form").send({ type: "scheduled_ot", workerId: String(w._id), date: "2026-07-02", fromTime: "18:00", toTime: "20:00" });
  const otReq = await RequestModel.findOne({ workerId: w._id, type: "scheduled_ot" });
  await ma.post(`/requests/${otReq!._id}/approve`).type("form").send({});
  assert("management approves a pending request", (await RequestModel.findById(otReq!._id))?.status === "approved");

  // Cleanup
  await Promise.all([
    RequestModel.deleteMany({ workerId: w._id }),
    WorkerModel.deleteOne({ _id: w._id }),
    UserModel.deleteMany({ email: { $in: [mgmt, sup] } }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E MANAGEMENT FAILED" : "\nE2E MANAGEMENT PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E MANAGEMENT ERROR:", e?.message ?? e); process.exit(1); });
