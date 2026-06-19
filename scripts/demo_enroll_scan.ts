/* DEMO: enroll a worker (save photo + face encoding) then scan at a station
   (register attendance), printing every artifact at each step. Cleans up after
   so the e2e suites stay green. Run: npx tsx scripts/demo_enroll_scan.ts */

import fs from "fs";
import path from "path";

import request from "supertest";
import mongoose from "mongoose";

import { createApp } from "../src/app";
import { config } from "../src/config";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { istHM } from "../src/lib/time";
import { generateStationKey, hashStationKey } from "../src/lib/stationKey";
import {
  WorkerModel, AttendanceModel, ProjectSiteModel, DesignationModel, SiteStationModel,
} from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const FIXTURE = path.join(process.cwd(), "test/fixtures/face_single.jpg");
const faceDataUrl = () => "data:image/jpeg;base64," + fs.readFileSync(FIXTURE).toString("base64");
const line = (t: string) => console.log(`\n──────── ${t} ────────`);

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable — start MongoDB."); process.exit(1); }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  const carpenter = await DesignationModel.findOne({ name: "Carpenter" });
  if (!vbw || !carpenter) throw new Error("Run npm run seed first.");

  const admin = request.agent(app);
  await admin.post("/login").type("form").send({ email: ADMIN_EMAIL, password: ADMIN_PW });

  // ===== STEP 1: ENROLL (this is where the image is saved) =====
  line("STEP 1 — ENROLL a worker (POST /workers)");
  console.log(`Input: name="Demo Ramesh", designation=Carpenter, site=${vbw.name}, photo=${path.basename(FIXTURE)}`);
  const enroll = await admin.post("/workers").type("form").send({
    name: "Demo Ramesh",
    designationId: String(carpenter._id),
    siteId: String(vbw._id),
    photoData: faceDataUrl(),
  });
  console.log(`Server: HTTP ${enroll.status} → ${enroll.headers.location}  (302 /workers = success)`);

  const worker = await WorkerModel.findOne({ name: "Demo Ramesh" }).sort({ createdAt: -1 });
  if (!worker) throw new Error("enrollment failed (no single face detected?)");

  line("STEP 2 — what got SAVED");
  const file = path.join(config.uploadDir, `${worker.empRegNo}.jpg`);
  const kb = fs.existsSync(file) ? (fs.statSync(file).size / 1024).toFixed(1) : "MISSING";
  console.log("A) The PHOTO is saved as a FILE on disk (not in the database):");
  console.log(`     path : ${file}`);
  console.log(`     size : ${kb} KB   served at : ${worker.photoUrl}`);
  console.log("\nB) The DATABASE worker document stores the FACE MATH, not the image:");
  console.log(`     empRegNo        : ${worker.empRegNo}   (auto-generated, unique)`);
  console.log(`     name            : ${worker.name}`);
  console.log(`     designationName : ${worker.designationName}   (denormalized)`);
  console.log(`     siteName        : ${worker.siteName}   (drives the location lock)`);
  console.log(`     status          : ${worker.status}`);
  console.log(`     photoUrl        : ${worker.photoUrl}`);
  console.log(`     faceEncoding    : [${worker.faceEncoding.length} numbers]  e.g. ${worker.faceEncoding.slice(0, 4).map((n) => n.toFixed(3)).join(", ")}, …`);
  console.log("   → recognition compares these 128 numbers; the photo is only for humans to view.");

  // ===== STEP 3: register a station and SCAN (register attendance) =====
  line("STEP 3 — a Site Station scans the same face (POST /station/scan)");
  const key = generateStationKey();
  const station = await SiteStationModel.create({
    projectSiteId: vbw._id, stationName: "Demo Station", stationKeyHash: hashStationKey(key), active: true,
  });
  const kiosk = request.agent(app);
  await kiosk.post("/station/login").type("form").send({ stationKey: key });
  const scan = await kiosk.post("/station/scan").set("Accept", "application/json").type("form").send({ photoData: faceDataUrl() });
  console.log(`Station bound to : ${vbw.name}`);
  console.log(`Scan result     : ${JSON.stringify(scan.body)}`);

  line("STEP 4 — the ATTENDANCE record that was registered");
  const att = await AttendanceModel.findOne({ workerId: worker._id }).sort({ createdAt: -1 });
  if (att) {
    console.log(`     date     : ${att.date}`);
    console.log(`     worker   : ${att.workerName} (${att.empRegNo})`);
    console.log(`     site     : ${att.siteName}`);
    console.log(`     In time  : ${istHM(att.inTime)} IST   Out: ${att.outTime ? istHM(att.outTime) : "— (still in)"}`);
    console.log(`     source   : ${att.source}   overtime: ${att.overtime.status}`);
  }

  // ===== cleanup so the test suites stay green =====
  line("CLEANUP (demo data removed; suites stay green)");
  if (fs.existsSync(file)) fs.unlinkSync(file);
  await Promise.all([
    WorkerModel.deleteOne({ _id: worker._id }),
    AttendanceModel.deleteMany({ workerId: worker._id }),
    SiteStationModel.deleteOne({ _id: station._id }),
  ]);
  console.log("removed: demo worker, its photo file, attendance row, demo station.");

  await mongoose.connection.close();
  console.log("\nDemo complete.");
  process.exit(0);
}
main().catch((e) => { console.error("\nDEMO ERROR:", e?.message ?? e); process.exit(1); });
