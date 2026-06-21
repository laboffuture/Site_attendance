/* End-to-end test for the Site Station + location-lock + attendance/OT.
   Verifies: station registration + key sign-in; In then Out (with overtime
   computed by backdating the In time); the location-lock rejecting a worker
   from another site and raising a flag; unknown + no-face handling; and that
   the kiosk requires a station session. Cleans up its data. Run: npm run e2e:station */

import fs from "fs";
import path from "path";

import request from "supertest";
import mongoose from "mongoose";
import * as jpeg from "jpeg-js";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { encodeFace } from "../src/lib/face";
import { siteLocalDate } from "../src/lib/time";
import {
  WorkerModel, ProjectSiteModel, DesignationModel,
  SiteStationModel, FlagEventModel, AttendanceModel,
} from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const FIXTURE = path.join(process.cwd(), "test/fixtures/face_single.jpg");
const S = Date.now().toString(36);

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
function faceDataUrl(): string {
  return "data:image/jpeg;base64," + fs.readFileSync(FIXTURE).toString("base64");
}
function blankDataUrl(): string {
  const w = 48, h = 48;
  const out = jpeg.encode({ data: Buffer.alloc(w * h * 4, 255), width: w, height: h }, 90);
  return "data:image/jpeg;base64," + Buffer.from(out.data).toString("base64");
}
function scan(agent: ReturnType<typeof request.agent>, dataUrl: string) {
  return agent.post("/station/scan").set("Accept", "application/json").type("form").send({ photoData: dataUrl });
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  const pvm = await ProjectSiteModel.findOne({ code: "PVM" });
  const carpenter = await DesignationModel.findOne({ name: "Carpenter" });
  if (!vbw || !pvm || !carpenter) throw new Error("Seed data missing — run npm run seed.");

  const enc = await encodeFace(fs.readFileSync(FIXTURE));
  assert("fixture encodes to 128-d", !!enc && enc.length === 128);

  // Admin registers a station bound to VBW; grab the one-time key from the page.
  const admin = request.agent(app);
  await admin.post("/login").type("form").send({ email: ADMIN_EMAIL, password: ADMIN_PW });
  const created = await admin.post("/stations").type("form").send({ stationName: `QA Station ${S}`, projectSiteId: String(vbw._id) });
  const keyMatch = /oh-keybox">([A-Za-z0-9_\-]+)</.exec(created.text);
  const stationKey = keyMatch ? keyMatch[1] : "";
  assert("station registered + key shown once", stationKey.length > 20);

  // Kiosk requires a station session.
  const anon = request.agent(app);
  assert("GET /station unauthenticated → redirect", (await anon.get("/station")).status === 302);
  assert("POST /station/scan unauthenticated → 401", (await scan(anon, blankDataUrl())).status === 401);

  // Station signs in with the key.
  const kiosk = request.agent(app);
  const login = await kiosk.post("/station/login").type("form").send({ stationKey });
  assert("station login → redirect to /station", login.status === 302 && login.headers.location === "/station");
  assert("capture screen shows site name", (await kiosk.get("/station")).text.includes(vbw.name));

  // --- In / Out + overtime (worker at the station's own site) ---
  const y = await WorkerModel.create({
    empRegNo: `QA-Y-${S}`, name: `QA Y ${S}`, designationId: carpenter._id, designationName: "Carpenter",
    siteId: vbw._id, siteName: vbw.name, faceEncoding: enc!, status: "active",
  });
  const r1 = (await scan(kiosk, faceDataUrl())).body;
  assert("first scan → IN", r1.status === "in" && r1.workerName === y.name);
  assert("attendance row created", !!(await AttendanceModel.findOne({ workerId: y._id, date: siteLocalDate() })));

  // Backdate the In time by 10h so the OUT scan runs past the shift window and
  // books overtime. The exact OT hours are the shift engine's job (and vary by
  // weekday vs Sunday window) — e2e_shift owns that precision. Here we only
  // assert the station flow records a long session as pending OT.
  await AttendanceModel.updateOne(
    { workerId: y._id, date: siteLocalDate() },
    { $set: { inTime: new Date(Date.now() - 10 * 3_600_000) } },
  );
  const r2 = (await scan(kiosk, faceDataUrl())).body;
  assert("second scan → OUT", r2.status === "out");
  assert("OUT computed ~10h total", r2.totalHours >= 9.8 && r2.totalHours <= 10.2);
  assert("overtime booked as pending", r2.overtimeHours > 0 && r2.overtimeStatus === "pending");
  await WorkerModel.deleteOne({ _id: y._id });

  // --- Location-lock: worker enrolled at PVM scans at the VBW station ---
  const x = await WorkerModel.create({
    empRegNo: `QA-X-${S}`, name: `QA X ${S}`, designationId: carpenter._id, designationName: "Carpenter",
    siteId: pvm._id, siteName: pvm.name, faceEncoding: enc!, status: "active",
  });
  const r3 = (await scan(kiosk, faceDataUrl())).body;
  assert("wrong-site scan rejected", r3.status === "wrong_site" && r3.homeSite === pvm.name);
  assert("flag event raised", !!(await FlagEventModel.findOne({ workerId: x._id, type: "wrong_site_scan" })));
  await WorkerModel.deleteOne({ _id: x._id });

  // --- Unknown + no-face ---
  assert("unknown face when no worker matches", (await scan(kiosk, faceDataUrl())).body.status === "unknown");
  assert("no-face image reported", (await scan(kiosk, blankDataUrl())).body.status === "no_face");

  // Cleanup
  await Promise.all([
    SiteStationModel.deleteMany({ stationName: `QA Station ${S}` }),
    FlagEventModel.deleteMany({ workerId: x._id }),
    AttendanceModel.deleteMany({ empRegNo: { $in: [`QA-Y-${S}`, `QA-X-${S}`] } }),
    WorkerModel.deleteMany({ empRegNo: { $in: [`QA-Y-${S}`, `QA-X-${S}`] } }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E STATION FAILED" : "\nE2E STATION PASSED");
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error("\nE2E STATION ERROR:", e?.message ?? e); process.exit(1); });
