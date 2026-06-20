/* E2E for enrolling/replacing a face on an ALREADY-registered worker (the
   imported workers have none). Self-contained; cleans up.
   Verifies: the edit page exposes a face-capture form; posting a real face
   sets the 128-d encoding + photo; a faceless image is rejected and leaves the
   worker faceless; scope is enforced. Run: npm run e2e:facecapture */

import fs from "fs";
import path from "path";

import request from "supertest";
import mongoose, { Types } from "mongoose";
import * as jpeg from "jpeg-js";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { config } from "../src/config";
import { BranchModel, ProjectSiteModel, WorkerModel, UserModel } from "../src/models";

const FIXTURE = path.join(process.cwd(), "test/fixtures/face_single.jpg");
const S = Date.now().toString(36);
const SUP_EMAIL = `qa-fc-${S}@trgbi.com`;
const PW = "Pass123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
function faceUrl(): string {
  return "data:image/jpeg;base64," + fs.readFileSync(FIXTURE).toString("base64");
}
function blankUrl(): string {
  const out = jpeg.encode({ data: Buffer.alloc(48 * 48 * 4, 255), width: 48, height: 48 }, 90);
  return "data:image/jpeg;base64," + Buffer.from(out.data).toString("base64");
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const branch = await BranchModel.create({ name: `QA FC Branch ${S}` });
  const site = await ProjectSiteModel.create({
    branchId: branch._id, name: `QA FC Site ${S}`, code: `QAFC${S}`.toUpperCase(),
    standardStartTime: "09:00", standardEndTime: "18:00",
  });
  // worker with NO face (like an imported one)
  const worker = await WorkerModel.create({
    empRegNo: `QA-FC-${S}`, name: `QA FC ${S}`, designationId: new Types.ObjectId(),
    designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active",
  });
  await UserModel.create({
    name: "QA FC Sup", email: SUP_EMAIL, passwordHash: await hashPassword(PW),
    role: "supervisor", assignedSiteIds: [site._id], active: true,
  });

  const sup = request.agent(app);
  assert("supervisor logs in", (await sup.post("/login").type("form").send({ email: SUP_EMAIL, password: PW })).status === 302);

  const edit = await sup.get(`/workers/${worker._id}/edit`);
  assert("edit page exposes a face-capture form", edit.text.includes(`/workers/${worker._id}/face`) && edit.text.includes('id="photoData"'));

  // faceless image rejected → still no face
  await sup.post(`/workers/${worker._id}/face`).type("form").send({ photoData: blankUrl() });
  let w = await WorkerModel.findById(worker._id);
  assert("faceless image leaves worker without a face", !!w && w.faceEncoding.length === 0);

  // real face → 128-d encoding + photo stored
  const ok = await sup.post(`/workers/${worker._id}/face`).type("form").send({ photoData: faceUrl() });
  assert("face enrol redirects back to edit", ok.status === 302);
  w = await WorkerModel.findById(worker._id);
  assert("128-d face encoding stored", !!w && w.faceEncoding.length === 128);
  assert("photoUrl set", !!w && !!w.photoUrl);
  assert("photo file written", fs.existsSync(path.join(config.uploadDir, `${worker._id}.jpg`)));

  // scope: a supervisor at another site can't enrol this worker's face
  const otherSite = await ProjectSiteModel.create({ branchId: branch._id, name: `QA FC Other ${S}`, code: `QAFCO${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const otherEmail = `qa-fco-${S}@trgbi.com`;
  await UserModel.create({ name: "QA FC Other Sup", email: otherEmail, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [otherSite._id], active: true });
  const other = request.agent(app);
  await other.post("/login").type("form").send({ email: otherEmail, password: PW });
  const blocked = await other.post(`/workers/${worker._id}/face`).type("form").send({ photoData: faceUrl() });
  assert("out-of-scope supervisor is redirected (not allowed)", blocked.status === 302 && blocked.headers.location === "/workers");

  // Cleanup
  try { fs.unlinkSync(path.join(config.uploadDir, `${worker._id}.jpg`)); } catch { /* ignore */ }
  await Promise.all([
    UserModel.deleteMany({ email: { $in: [SUP_EMAIL, otherEmail] } }),
    WorkerModel.deleteOne({ _id: worker._id }),
    ProjectSiteModel.deleteMany({ _id: { $in: [site._id, otherSite._id] } }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E FACECAPTURE FAILED" : "\nE2E FACECAPTURE PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E FACECAPTURE ERROR:", e?.message ?? e); process.exit(1); });
