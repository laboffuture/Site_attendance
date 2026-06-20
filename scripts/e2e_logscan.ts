/* E2E for the Supervisor "Log Attendance" in-session face-scan.
   Self-contained (creates its own branch/sites/supervisor/worker, cleans up).
   Verifies: pick-site scan → IN then OUT (last-scan-wins + OT); location-lock
   to the picked site rejects + flags a worker whose home site differs; geofence
   blocks (no fix → location_required, far → out_of_range, near → IN); no-face;
   and that a Supervisor can't scan at a site they aren't assigned to.
   Run: npm run e2e:logscan */

import fs from "fs";
import path from "path";

import request from "supertest";
import mongoose, { Types } from "mongoose";
import * as jpeg from "jpeg-js";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { encodeFace } from "../src/lib/face";
import { siteLocalDate } from "../src/lib/time";
import {
  BranchModel, ProjectSiteModel, WorkerModel, UserModel,
  AttendanceModel, FlagEventModel,
} from "../src/models";

const FIXTURE = path.join(process.cwd(), "test/fixtures/face_single.jpg");
const S = Date.now().toString(36);
const SUP_EMAIL = `qa-ls-${S}@trgbi.com`;
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
function scan(agent: ReturnType<typeof request.agent>, body: Record<string, string>) {
  return agent.post("/attendance/scan").set("Accept", "application/json").type("form").send(body);
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const enc = await encodeFace(fs.readFileSync(FIXTURE));
  assert("fixture encodes to 128-d", !!enc && enc.length === 128);

  // --- self-contained org: 1 branch, 3 sites (A,B home sites; C off-scope) ---
  const branch = await BranchModel.create({ name: `QA LS Branch ${S}` });
  const mkSite = (code: string, name: string) =>
    ProjectSiteModel.create({ branchId: branch._id, name, code, standardStartTime: "09:00", standardEndTime: "18:00" });
  const siteA = await mkSite(`QALSA${S}`.toUpperCase(), `QA LS A ${S}`);
  const siteB = await mkSite(`QALSB${S}`.toUpperCase(), `QA LS B ${S}`);
  const siteC = await mkSite(`QALSC${S}`.toUpperCase(), `QA LS C ${S}`);

  // supervisor scoped to A + B (not C)
  await UserModel.create({
    name: "QA LS Sup", email: SUP_EMAIL, passwordHash: await hashPassword(PW),
    role: "supervisor", assignedSiteIds: [siteA._id, siteB._id], active: true,
  });
  const sup = request.agent(app);
  const login = await sup.post("/login").type("form").send({ email: SUP_EMAIL, password: PW });
  assert("supervisor logs in", login.status === 302);
  assert("scan screen lists the 2 assigned sites", (await sup.get("/attendance/scan")).text.split("data-fenced").length - 1 === 2);

  const desig = new Types.ObjectId();
  const mkWorker = (reg: string, site: typeof siteA) =>
    WorkerModel.create({
      empRegNo: reg, name: `W ${reg}`, designationId: desig, designationName: "Carpenter",
      siteId: site._id, siteName: site.name, faceEncoding: enc!, status: "active",
    });

  // --- Phase 1: IN then OUT at the picked site ---
  const wA = await mkWorker(`QA-LS-A-${S}`, siteA);
  const r1 = (await scan(sup, { photoData: faceUrl(), siteId: String(siteA._id) })).body;
  assert("first scan → IN", r1.status === "in" && r1.workerName === wA.name);
  await AttendanceModel.updateOne({ workerId: wA._id, date: siteLocalDate() }, { $set: { inTime: new Date(Date.now() - 10 * 3_600_000) } });
  const r2 = (await scan(sup, { photoData: faceUrl(), siteId: String(siteA._id) })).body;
  assert("second scan → OUT ~10h + OT pending", r2.status === "out" && r2.totalHours >= 9.5 && r2.overtimeStatus === "pending");
  await AttendanceModel.deleteMany({ workerId: wA._id });
  await WorkerModel.deleteOne({ _id: wA._id });

  // --- Phase 2: location-lock — worker's home site (B) ≠ picked site (A) ---
  const wB = await mkWorker(`QA-LS-B-${S}`, siteB);
  const r3 = (await scan(sup, { photoData: faceUrl(), siteId: String(siteA._id) })).body;
  assert("wrong-site scan rejected", r3.status === "wrong_site" && r3.homeSite === siteB.name && r3.thisSite === siteA.name);
  assert("wrong-site flag raised", !!(await FlagEventModel.findOne({ workerId: wB._id, type: "wrong_site_scan" })));
  await FlagEventModel.deleteMany({ workerId: wB._id });
  await WorkerModel.deleteOne({ _id: wB._id });

  // --- Phase 3: geofence enforcement on site A ---
  await ProjectSiteModel.updateOne({ _id: siteA._id }, { $set: { latitude: 13.0, longitude: 80.0, geofenceRadiusMeters: 200 } });
  const wA2 = await mkWorker(`QA-LS-G-${S}`, siteA);
  const noFix = (await scan(sup, { photoData: faceUrl(), siteId: String(siteA._id) })).body;
  assert("geofenced + no GPS → location_required", noFix.status === "location_required");
  const far = (await scan(sup, { photoData: faceUrl(), siteId: String(siteA._id), lat: "13.1", lng: "80.0", accuracy: "10" })).body;
  assert("geofenced + far GPS → out_of_range", far.status === "out_of_range" && far.distanceMeters > 200);
  const near = (await scan(sup, { photoData: faceUrl(), siteId: String(siteA._id), lat: "13.0", lng: "80.0", accuracy: "10" })).body;
  assert("geofenced + near GPS → IN", near.status === "in");
  await AttendanceModel.deleteMany({ workerId: wA2._id });
  await WorkerModel.deleteOne({ _id: wA2._id });

  // --- Phase 4: no-face + off-scope site ---
  // Use site B (no geofence) — at geofenced site A, the GPS gate fires before
  // face detection, so a no-GPS blank image would return location_required.
  assert("no-face image → no_face", (await scan(sup, { photoData: blankUrl(), siteId: String(siteB._id) })).body.status === "no_face");
  const offScope = (await scan(sup, { photoData: faceUrl(), siteId: String(siteC._id) })).body;
  assert("cannot scan at an unassigned site", offScope.status === "error");

  // Cleanup
  await Promise.all([
    UserModel.deleteOne({ email: SUP_EMAIL }),
    ProjectSiteModel.deleteMany({ _id: { $in: [siteA._id, siteB._id, siteC._id] } }),
    BranchModel.deleteOne({ _id: branch._id }),
    WorkerModel.deleteMany({ empRegNo: new RegExp(`QA-LS-.*-${S}`) }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E LOGSCAN FAILED" : "\nE2E LOGSCAN PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E LOGSCAN ERROR:", e?.message ?? e); process.exit(1); });
