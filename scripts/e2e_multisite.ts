/* E2E for multi-site employees: a worker assigned to TWO sites appears in BOTH
   sites' attendance grids; a supervisor at the SECOND site (only) can open the
   worker's edit (canUseWorker); the primary siteId is the FIRST assigned site;
   and a worker created with only `siteId` gets siteIds=[siteId] via the pre-save
   hook. Self-contained; cleans up. Run: npm run e2e:multisite */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { BranchModel, ProjectSiteModel, WorkerModel, UserModel } from "../src/models";

const S = Date.now().toString(36);
const PW = "Pass123!";

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

  const branch = await BranchModel.create({ name: `QA MS Branch ${S}` });
  const siteA = await ProjectSiteModel.create({ branchId: branch._id, name: `QA MS Site A ${S}`, code: `QAMSA${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const siteB = await ProjectSiteModel.create({ branchId: branch._id, name: `QA MS Site B ${S}`, code: `QAMSB${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const desig = new Types.ObjectId();

  // --- A worker assigned to TWO sites; primary = the FIRST (siteA). ---
  // Mirrors the enroll route: siteIds chosen, primary siteName denormalized to
  // the first pick. The hook derives the primary siteId from siteIds[0].
  const multi = await WorkerModel.create({
    empRegNo: `QA-MS-MULTI-${S}`, name: `MS Multi ${S}`, designationId: desig, designationName: "Carpenter",
    siteIds: [siteA._id, siteB._id], siteName: siteA.name, faceEncoding: [], status: "active",
  });
  assert("multi-site worker primary siteId is the first assigned (siteA), set by hook from siteIds[0]", String(multi.siteId) === String(siteA._id));
  assert("multi-site worker keeps both siteIds in order", multi.siteIds.map(String).join(",") === [siteA._id, siteB._id].map(String).join(","));

  // --- (model) a worker created with ONLY siteId gets siteIds=[siteId] via hook. ---
  const single = await WorkerModel.create({
    empRegNo: `QA-MS-SINGLE-${S}`, name: `MS Single ${S}`, designationId: desig, designationName: "Carpenter",
    siteId: siteB._id, siteName: siteB.name, faceEncoding: [], status: "active",
  });
  assert("single-site worker auto-populates siteIds=[siteId] via pre-save hook", single.siteIds.map(String).join(",") === String(siteB._id));

  // --- Supervisor who can see BOTH sites: the worker shows in BOTH grids. ---
  const supBoth = `qa-ms-both-${S}@trgbi.com`;
  await UserModel.create({ name: "MS Sup Both", email: supBoth, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [siteA._id, siteB._id], active: true });
  const sb = await login(app, supBoth);
  const gridA = await sb.get(`/attendance?siteId=${siteA._id}`);
  const gridB = await sb.get(`/attendance?siteId=${siteB._id}`);
  assert("multi-site worker appears in site A's attendance grid", gridA.status === 200 && gridA.text.includes(`QA-MS-MULTI-${S}`));
  assert("multi-site worker appears in site B's attendance grid", gridB.status === 200 && gridB.text.includes(`QA-MS-MULTI-${S}`));

  // --- Supervisor at the SECOND site ONLY can open the worker's edit (canUseWorker). ---
  const supB = `qa-ms-b-${S}@trgbi.com`;
  await UserModel.create({ name: "MS Sup B", email: supB, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [siteB._id], active: true });
  const s2 = await login(app, supB);
  const editAsB = await s2.get(`/workers/${multi._id}/edit`);
  assert("supervisor at site B (non-primary) can open the multi-site worker's edit", editAsB.status === 200 && editAsB.text.includes(`QA-MS-MULTI-${S}`));
  // The roster (scoped by siteIds) also lists the worker for the site-B supervisor.
  const rosterB = await s2.get(`/workers`);
  assert("site-B supervisor's roster lists the multi-site worker (siteIds scope)", rosterB.status === 200 && rosterB.text.includes(`QA-MS-MULTI-${S}`));

  // --- Negative: a supervisor at an UNRELATED site cannot open the edit. ---
  const siteC = await ProjectSiteModel.create({ branchId: branch._id, name: `QA MS Site C ${S}`, code: `QAMSC${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const supC = `qa-ms-c-${S}@trgbi.com`;
  await UserModel.create({ name: "MS Sup C", email: supC, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [siteC._id], active: true });
  const s3 = await login(app, supC);
  const editAsC = await s3.get(`/workers/${multi._id}/edit`);
  assert("supervisor at unrelated site C is blocked from the edit (redirect)", editAsC.status === 302);
  const gridC = await s3.get(`/attendance?siteId=${siteC._id}`);
  assert("multi-site worker does NOT appear in unrelated site C's grid", gridC.status === 200 && !gridC.text.includes(`QA-MS-MULTI-${S}`));

  // Cleanup
  await Promise.all([
    WorkerModel.deleteMany({ empRegNo: { $in: [`QA-MS-MULTI-${S}`, `QA-MS-SINGLE-${S}`] } }),
    UserModel.deleteMany({ email: { $in: [supBoth, supB, supC] } }),
    ProjectSiteModel.deleteMany({ _id: { $in: [siteA._id, siteB._id, siteC._id] } }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E MULTISITE FAILED" : "\nE2E MULTISITE PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E MULTISITE ERROR:", e?.message ?? e); process.exit(1); });
