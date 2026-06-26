/* E2E for GPS capture (capture-only). Verifies: a scan with coordinates stores
   inGeo with distance-from-site; a scan with no coordinates stores
   available:false (attendance still logged); site coordinates save via the org
   form. Cleans up. Run: npm run e2e:geo */

import fs from "fs";
import path from "path";

import request from "supertest";
import mongoose from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { encodeFace } from "../src/lib/face";
import { haversineMeters, checkGeofence, pointInPolygon } from "../src/lib/geo";
import { generateStationKey, hashStationKey } from "../src/lib/stationKey";
import {
  WorkerModel, AttendanceModel, ProjectSiteModel, DesignationModel, SiteStationModel,
} from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const FIXTURE = path.join(process.cwd(), "test/fixtures/face_single.jpg");
const faceDataUrl = () => "data:image/jpeg;base64," + fs.readFileSync(FIXTURE).toString("base64");
const S = Date.now().toString(36);

// Site coordinates (T.Nagar, Chennai) and a worker scanning ~ this point.
const SITE_LAT = 13.0405, SITE_LNG = 80.2337;
const SCAN_LAT = 13.0410, SCAN_LNG = 80.2340; // a short distance away

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  const carpenter = await DesignationModel.findOne({ name: "Carpenter" });
  if (!vbw || !carpenter) throw new Error("Run npm run seed first.");
  const enc = await encodeFace(fs.readFileSync(FIXTURE));

  const admin = request.agent(app);
  await admin.post("/login").type("form").send({ email: ADMIN_EMAIL, password: ADMIN_PW });

  // 1) Save site coordinates via the org edit form.
  await admin.post(`/org/sites/${vbw._id}`).type("form").send({
    branchId: String(vbw.branchId), name: vbw.name, code: vbw.code,
    standardStartTime: vbw.standardStartTime, standardEndTime: vbw.standardEndTime,
    latitude: String(SITE_LAT), longitude: String(SITE_LNG), geofenceRadiusMeters: "200",
  });
  const savedSite = await ProjectSiteModel.findById(vbw._id).lean();
  assert("site latitude saved", savedSite?.latitude === SITE_LAT);
  assert("site longitude saved", savedSite?.longitude === SITE_LNG);
  assert("geofence radius saved", savedSite?.geofenceRadiusMeters === 200);

  // invalid coord rejected
  await admin.post(`/org/sites/${vbw._id}`).type("form").send({
    branchId: String(vbw.branchId), name: vbw.name, code: vbw.code,
    standardStartTime: vbw.standardStartTime, standardEndTime: vbw.standardEndTime,
    latitude: "999", longitude: "80", geofenceRadiusMeters: "200",
  });
  const stillSite = await ProjectSiteModel.findById(vbw._id).lean();
  assert("invalid latitude rejected (unchanged)", stillSite?.latitude === SITE_LAT);

  // A worker + a station at VBW.
  const w = await WorkerModel.create({
    empRegNo: `QA-GEO-${S}`, name: `QA Geo ${S}`, designationId: carpenter._id,
    designationName: "Carpenter", siteId: vbw._id, siteName: vbw.name, faceEncoding: enc!, status: "active",
  });
  const key = generateStationKey();
  const station = await SiteStationModel.create({
    projectSiteId: vbw._id, stationName: `QA Geo Station ${S}`, stationKeyHash: hashStationKey(key), active: true,
  });
  const kiosk = request.agent(app);
  await kiosk.post("/station/login").type("form").send({ stationKey: key });

  // 2) Scan WITH coordinates → inGeo stored with distance.
  const r1 = await kiosk.post("/station/scan").set("Accept", "application/json").type("form")
    .send({ photoData: faceDataUrl(), action: "in", lat: String(SCAN_LAT), lng: String(SCAN_LNG), accuracy: "12" });
  assert("scan with GPS → in", r1.body.status === "in");
  assert("response reports geo available", r1.body.geo && r1.body.geo.available === true);

  const rec = await AttendanceModel.findOne({ workerId: w._id }).lean();
  assert("inGeo stored + available", !!rec?.inGeo && rec.inGeo.available === true);
  const expected = Math.round(haversineMeters(SCAN_LAT, SCAN_LNG, SITE_LAT, SITE_LNG));
  assert(`distanceMeters computed (~${expected}m)`, !!rec?.inGeo && Math.abs((rec.inGeo.distanceMeters ?? -1) - expected) <= 1);
  assert("accuracy stored", rec?.inGeo?.accuracy === 12);

  // Step the IN past the scan-debounce window so the next scan is a real OUT,
  // not an accidental double-tap (which the server now correctly ignores).
  await AttendanceModel.updateOne({ workerId: w._id, outTime: null }, { $set: { inTime: new Date(Date.now() - 2 * 3_600_000) } });

  // 3) Second scan (Out) WITHOUT coordinates → still logs, outGeo available:false.
  const r2 = await kiosk.post("/station/scan").set("Accept", "application/json").type("form")
    .send({ photoData: faceDataUrl(), action: "out" });
  assert("scan without GPS still logs → out", r2.body.status === "out");
  assert("response reports geo unavailable", r2.body.geo && r2.body.geo.available === false);
  const rec2 = await AttendanceModel.findOne({ workerId: w._id }).lean();
  assert("outGeo recorded as unavailable", !!rec2?.outGeo && rec2.outGeo.available === false);
  assert("inGeo preserved across the out scan", !!rec2?.inGeo && rec2.inGeo.available === true);

  // 4) Polygon geofence: a drawn rectangle saves via the form + enforces by point-in-polygon.
  const SQUARE = [[13.0400, 80.2330], [13.0400, 80.2345], [13.0412, 80.2345], [13.0412, 80.2330]];
  await admin.post(`/org/sites/${vbw._id}`).type("form").send({
    branchId: String(vbw.branchId), name: vbw.name, code: vbw.code,
    standardStartTime: vbw.standardStartTime, standardEndTime: vbw.standardEndTime,
    geofencePolygon: JSON.stringify(SQUARE),
  });
  const polySite = await ProjectSiteModel.findById(vbw._id).lean();
  assert("polygon geofence saved (4 points)", Array.isArray(polySite?.geofencePolygon) && polySite!.geofencePolygon.length === 4);
  assert("point-in-polygon: inside point is inside", pointInPolygon(13.0406, 80.2338, SQUARE) === true);
  assert("point-in-polygon: far point is outside", pointInPolygon(13.0500, 80.2500, SQUARE) === false);
  assert("checkGeofence polygon → inside", checkGeofence(polySite!, { available: true, lat: 13.0406, lng: 80.2338, distanceMeters: 10 }) === "inside");
  assert("checkGeofence polygon → outside", checkGeofence(polySite!, { available: true, lat: 13.0500, lng: 80.2500, distanceMeters: 5000 }) === "outside");
  assert("checkGeofence polygon → no_fix without GPS", checkGeofence(polySite!, { available: false, lat: null, lng: null, distanceMeters: null }) === "no_fix");

  // Cleanup
  await Promise.all([
    AttendanceModel.deleteMany({ workerId: w._id }),
    WorkerModel.deleteOne({ _id: w._id }),
    SiteStationModel.deleteOne({ _id: station._id }),
  ]);
  // Clear the test coordinates + polygon off the shared seed site.
  await ProjectSiteModel.findByIdAndUpdate(vbw._id, { latitude: null, longitude: null, geofenceRadiusMeters: null, geofencePolygon: [] });

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E GEO FAILED" : "\nE2E GEO PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E GEO ERROR:", e?.message ?? e); process.exit(1); });
