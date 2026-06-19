/* Removes the demo seed data (DEMO-* workers + their attendance/flags, the
   "Demo Station", and the VBW demo coordinates). The demo workers share one
   sample face, which collides with the face-match e2e suites. Regenerate the
   demo anytime with `npm run demo-prep`. Run: npx tsx scripts/clean_demo.ts */
import fs from "fs";
import path from "path";

import mongoose from "mongoose";

import { config } from "../src/config";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import {
  WorkerModel, AttendanceModel, FlagEventModel, SiteStationModel, ProjectSiteModel,
} from "../src/models";

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const demo = await WorkerModel.find({ empRegNo: /^DEMO-/ }).lean();
  const ids = demo.map((w) => w._id);
  const att = await AttendanceModel.deleteMany({ workerId: { $in: ids } });
  const flg = await FlagEventModel.deleteMany({ workerId: { $in: ids } });
  const wrk = await WorkerModel.deleteMany({ empRegNo: /^DEMO-/ });
  const stn = await SiteStationModel.deleteMany({ stationName: "Demo Station" });
  await ProjectSiteModel.updateOne({ code: "VBW" }, { latitude: null, longitude: null, geofenceRadiusMeters: null });
  for (const w of demo) {
    const f = path.join(config.uploadDir, `${w.empRegNo}.jpg`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  console.log(`Removed: ${wrk.deletedCount} workers, ${att.deletedCount} attendance, ${flg.deletedCount} flags, ${stn.deletedCount} station. VBW coords cleared.`);

  await mongoose.connection.close();
  process.exit(0);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
