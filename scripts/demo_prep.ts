/* DEMO PREP — makes the app look like a live system for an office demo.
   Idempotent: re-running resets the demo data. Creates sample workers (with
   photos), a few days of attendance (incl. a pending OT + a missed-clockout
   flag), sets a site's GPS coordinates, and registers a "Demo Station" whose
   key is printed. Everything is prefixed DEMO so it's easy to remove later.
   Run: npx tsx scripts/demo_prep.ts */

import fs from "fs";
import path from "path";

import mongoose, { Types } from "mongoose";

import { config } from "../src/config";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { encodeFace } from "../src/lib/face";
import { generateStationKey, hashStationKey } from "../src/lib/stationKey";
import { siteLocalDate, istDateTime } from "../src/lib/time";
import {
  WorkerModel, AttendanceModel, FlagEventModel, ProjectSiteModel,
  DesignationModel, SiteStationModel, UserModel,
} from "../src/models";

const FIXTURE = path.join(process.cwd(), "test/fixtures/face_single.jpg");
const day = (offset: number) => siteLocalDate(new Date(Date.now() + offset * 86_400_000));

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable — start MongoDB."); process.exit(1); }

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  if (!vbw) throw new Error("Run `npm run seed` first.");
  const desig = async (n: string) => (await DesignationModel.findOne({ name: n }))?._id ?? new Types.ObjectId();
  const carpenter = await desig("Carpenter");
  const electrician = await desig("Electrician");
  const helper = await desig("Helper");

  // ---- clean any previous demo data ----
  const prevWorkers = await WorkerModel.find({ empRegNo: /^DEMO-/ }).lean();
  const prevIds = prevWorkers.map((w) => w._id);
  await Promise.all([
    AttendanceModel.deleteMany({ workerId: { $in: prevIds } }),
    FlagEventModel.deleteMany({ workerId: { $in: prevIds } }),
    WorkerModel.deleteMany({ empRegNo: /^DEMO-/ }),
    SiteStationModel.deleteMany({ stationName: "Demo Station" }),
  ]);

  // ---- demo staff logins (idempotent) ----
  const pw = await hashPassword("Demo123!");
  const pvm = await ProjectSiteModel.findOne({ code: "PVM" });
  for (const u of [
    { name: "Priya (PM)", email: "pm@trgbi.com", role: "pm", assignedSiteIds: [vbw._id, pvm?._id].filter(Boolean) },
    { name: "Vijay (PE)", email: "pe@trgbi.com", role: "pe", assignedSiteIds: [vbw._id] },
    { name: "Saran (Supervisor)", email: "supervisor@trgbi.com", role: "supervisor", assignedSiteIds: [vbw._id] },
  ]) {
    await UserModel.updateOne({ email: u.email }, { $set: { ...u, active: true, passwordHash: pw } }, { upsert: true });
  }

  // ---- site GPS coordinates (T.Nagar, Chennai) ----
  await ProjectSiteModel.findByIdAndUpdate(vbw._id, { latitude: 13.0405, longitude: 80.2337, geofenceRadiusMeters: 200 });

  // ---- sample workers (share the fixture face; for screen populate only) ----
  const encoding = await encodeFace(fs.readFileSync(FIXTURE));
  if (!encoding) throw new Error("Could not encode the demo fixture face.");
  fs.mkdirSync(config.uploadDir, { recursive: true });

  const people = [
    { reg: "DEMO-0001", name: "Ramesh Kumar", desigId: carpenter, desigName: "Carpenter" },
    { reg: "DEMO-0002", name: "Suresh R", desigId: electrician, desigName: "Electrician" },
    { reg: "DEMO-0003", name: "Mani P", desigId: helper, desigName: "Helper" },
  ];
  const workers: Record<string, Types.ObjectId> = {};
  for (const p of people) {
    fs.copyFileSync(FIXTURE, path.join(config.uploadDir, `${p.reg}.jpg`));
    const w = await WorkerModel.create({
      empRegNo: p.reg, name: p.name, designationId: p.desigId, designationName: p.desigName,
      siteId: vbw._id, siteName: vbw.name, faceEncoding: encoding,
      photoUrl: `/static/uploads/${p.reg}.jpg`, status: "active",
    });
    workers[p.reg] = w._id;
  }

  // ---- attendance across a few days ----
  const base = {
    siteId: vbw._id, siteName: vbw.name, branchId: vbw.branchId, branchName: "Chennai",
    designationId: carpenter, designationName: "Carpenter",
  };
  const mk = (reg: string, name: string, date: string, inHM: string, outHM: string | null, ot = 0) => ({
    ...base, workerId: workers[reg], empRegNo: reg, workerName: name, date,
    inTime: istDateTime(date, inHM),
    outTime: outHM ? istDateTime(date, outHM) : null,
    totalHours: outHM ? Math.round(((istDateTime(date, outHM).getTime() - istDateTime(date, inHM).getTime()) / 3_600_000) * 100) / 100 : null,
    standardHours: outHM ? 9 : null,
    overtime: { computedHours: ot, status: ot > 0 ? "pending" : "none" },
    source: "scan",
    inGeo: { available: true, lat: 13.0406, lng: 80.2338, accuracy: 14, distanceMeters: 18, capturedAt: istDateTime(date, inHM) },
  });

  await AttendanceModel.insertMany([
    mk("DEMO-0001", "Ramesh Kumar", day(0), "09:02", null),                 // present today (still in)
    mk("DEMO-0002", "Suresh R", day(-1), "08:00", "18:30", 1.5),            // yesterday: OT 1.5h pending
    mk("DEMO-0001", "Ramesh Kumar", day(-1), "09:00", "18:05"),            // yesterday: normal
    mk("DEMO-0003", "Mani P", day(-2), "09:00", "18:00"),                  // 2 days ago: normal
    mk("DEMO-0002", "Suresh R", day(-2), "09:10", "18:10"),               // 2 days ago: normal
    mk("DEMO-0003", "Mani P", day(-3), "09:00", null),                    // 3 days ago: left open
  ]);

  // ---- a missed-clock-out flag for the old open record ----
  const openRec = await AttendanceModel.findOne({ workerId: workers["DEMO-0003"], date: day(-3) });
  if (openRec) {
    await FlagEventModel.create({
      type: "missed_clockout", workerId: workers["DEMO-0003"], workerName: "Mani P",
      attendanceId: openRec._id, date: day(-3),
      homeSiteId: vbw._id, homeSiteName: vbw.name, attemptedSiteId: vbw._id, attemptedSiteName: vbw.name,
    });
  }

  // ---- a Demo Station bound to VBW (key shown once, here) ----
  const key = generateStationKey();
  await SiteStationModel.create({
    projectSiteId: vbw._id, stationName: "Demo Station", stationKeyHash: hashStationKey(key), active: true,
  });

  console.log("\n================  DEMO READY  ================");
  console.log("Web (PC):  http://localhost:3000");
  console.log("  Management : admin@trgbi.com / ChangeMe123!");
  console.log("  PM         : pm@trgbi.com / Demo123!");
  console.log("  PE         : pe@trgbi.com / Demo123!");
  console.log("  Supervisor : supervisor@trgbi.com / Demo123!");
  console.log("\nSeeded at VBW — T.Nagar (Chennai), GPS set:");
  console.log("  3 workers (Ramesh, Suresh, Mani), 6 attendance rows across 4 days,");
  console.log("  1 pending overtime (Suresh, 1.5h), 1 missed-clock-out flag (Mani).");
  console.log("\nSite Station (kiosk):  http://localhost:3000/station/login");
  console.log(`  Station key:  ${key}`);
  console.log("=============================================\n");

  await mongoose.connection.close();
  process.exit(0);
}
main().catch((e) => { console.error("DEMO PREP ERROR:", e?.message ?? e); process.exit(1); });
