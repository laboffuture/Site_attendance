/* E2E for the face-onboarding sweep: imported (faceless) workers show as
   "Not registered" on the roster, can be filtered, carry a live progress count,
   and a dedicated capture page enrols a face (returning to the sweep). Scoped to
   the supervisor's sites. Self-contained; cleans up. Run: npm run e2e:face-onboarding */
import fs from "fs";
import path from "path";

import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { BranchModel, ProjectSiteModel, WorkerModel, UserModel } from "../src/models";

const FIXTURE = path.join(process.cwd(), "test/fixtures/face_single.jpg");
const S = Date.now().toString(36);
const PW = "Pass123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
function faceDataUrl(): string {
  return "data:image/jpeg;base64," + fs.readFileSync(FIXTURE).toString("base64");
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

  const branch = await BranchModel.create({ name: `QA FO ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA FO Site ${S}`, code: `QAFO${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const desig = new Types.ObjectId();
  async function worker(reg: string) {
    return WorkerModel.create({ empRegNo: reg, name: `W ${reg}`, designationId: desig, designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active" });
  }
  const wa = await worker(`QA-FO-A-${S}`); // will be enrolled
  const wb = await worker(`QA-FO-B-${S}`); // stays unregistered

  const sup = `qa-fosup-${S}@trgbi.com`;
  await UserModel.create({ name: "FO Sup", email: sup, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [site._id], active: true });

  const sa = await login(app, sup);

  // Roster shows both as not-registered, with a 0/2 progress count.
  const roster = await sa.get("/workers");
  assert("roster lists the imported workers", roster.text.includes(`QA-FO-A-${S}`) && roster.text.includes(`QA-FO-B-${S}`));
  assert("roster shows a Not registered badge", roster.text.includes("Not registered"));
  assert("progress count starts at 0 / 2", roster.text.includes("Face registered: 0 / 2"));

  // Unregistered filter narrows to the faceless workers.
  const unreg = await sa.get("/workers?face=unregistered");
  assert("filter includes both faceless workers", unreg.text.includes(`QA-FO-A-${S}`) && unreg.text.includes(`QA-FO-B-${S}`));

  // Dedicated capture page for worker A.
  const page = await sa.get(`/workers/${wa._id}/face`);
  assert("face page → 200", page.status === 200);
  assert("face page shows the worker + capture form", page.text.includes(wa.name) && page.text.includes(`/workers/${wa._id}/face`) && page.text.includes("photoData"));

  // Enrol A's face → returns to the sweep, A gains an encoding.
  const post = await sa.post(`/workers/${wa._id}/face`).type("form").send({ photoData: faceDataUrl(), returnTo: "roster" });
  assert("enrol redirects back to the sweep", post.status === 302 && /\/workers\?face=unregistered/.test(post.headers.location ?? ""));
  const after = await WorkerModel.findById(wa._id).lean();
  assert("worker A now has a face encoding", (after?.faceEncoding?.length ?? 0) > 0);

  // Progress grows; A drops out of the unregistered filter, B remains.
  const roster2 = await sa.get("/workers");
  assert("progress count grows to 1 / 2", roster2.text.includes("Face registered: 1 / 2"));
  const unreg2 = await sa.get("/workers?face=unregistered");
  assert("enrolled worker leaves the filter", !unreg2.text.includes(`QA-FO-A-${S}`) && unreg2.text.includes(`QA-FO-B-${S}`));

  // Scope: a supervisor at another site cannot open A's face page.
  const otherSite = await ProjectSiteModel.create({ branchId: branch._id, name: `QA FO Other ${S}`, code: `QAFOO${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const sup2 = `qa-fosup2-${S}@trgbi.com`;
  await UserModel.create({ name: "FO Sup2", email: sup2, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [otherSite._id], active: true });
  const s2 = await login(app, sup2);
  const blocked = await s2.get(`/workers/${wa._id}/face`);
  assert("out-of-scope supervisor cannot open the face page", blocked.status === 302);

  // Cleanup
  await Promise.all([
    WorkerModel.deleteMany({ siteId: site._id }),
    UserModel.deleteMany({ email: { $in: [sup, sup2] } }),
    ProjectSiteModel.deleteMany({ _id: { $in: [site._id, otherSite._id] } }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  void wb;
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E FACE ONBOARDING FAILED" : "\nE2E FACE ONBOARDING PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E FACE ONBOARDING ERROR:", e?.message ?? e); process.exit(1); });
