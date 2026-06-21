/* E2E for the PM/Supervisor login geofence indicator: POST /me/location-check
   returns inside/outside/no_fix/off against the user's assigned geofenced sites
   and records each check. Self-contained; cleans up. Run: npm run e2e:logingeo */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { BranchModel, ProjectSiteModel, UserModel, LoginGeoCheckModel } from "../src/models";

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

  const branch = await BranchModel.create({ name: `QA LG ${S}` });
  const SITE_LAT = 13.0405, SITE_LNG = 80.2337;
  const site = await ProjectSiteModel.create({
    branchId: branch._id, name: `QA LG Site ${S}`, code: `QALG${S}`.toUpperCase(),
    standardStartTime: "09:00", standardEndTime: "18:00",
    latitude: SITE_LAT, longitude: SITE_LNG, geofenceRadiusMeters: 200,
  });
  const noGeoSite = await ProjectSiteModel.create({
    branchId: branch._id, name: `QA LG NoGeo ${S}`, code: `QALGN${S}`.toUpperCase(),
    standardStartTime: "09:00", standardEndTime: "18:00",
  });

  const sup = `qa-lgsup-${S}@trgbi.com`, supNo = `qa-lgsupno-${S}@trgbi.com`;
  await UserModel.create({ name: "LG Sup", email: sup, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [site._id], active: true });
  await UserModel.create({ name: "LG SupNo", email: supNo, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [noGeoSite._id], active: true });

  const sa = await login(app, sup);

  // At the site → inside.
  const inside = await sa.post("/me/location-check").type("form").send({ lat: String(SITE_LAT), lng: String(SITE_LNG), accuracy: "12" });
  assert("at the site → inside", inside.body.status === "inside" && inside.body.siteName === site.name);

  // Far away (Delhi) → outside, with a distance.
  const outside = await sa.post("/me/location-check").type("form").send({ lat: "28.6139", lng: "77.2090" });
  assert("far away → outside", outside.body.status === "outside" && outside.body.distanceMeters > 1000);

  // No fix → no_fix.
  const noFix = await sa.post("/me/location-check").type("form").send({});
  assert("no GPS → no_fix", noFix.body.status === "no_fix");

  // Supervisor whose site has no geofence → off.
  const sNo = await login(app, supNo);
  const off = await sNo.post("/me/location-check").type("form").send({ lat: String(SITE_LAT), lng: String(SITE_LNG) });
  assert("no geofenced site → off", off.body.status === "off");

  // Checks were recorded (tracking).
  const recorded = await LoginGeoCheckModel.countDocuments({ userName: "LG Sup" });
  assert("checks recorded for tracking", recorded >= 3);
  const outsideRec = await LoginGeoCheckModel.findOne({ userName: "LG Sup", status: "outside" }).lean();
  assert("outside check stored nearest site + distance", !!outsideRec && outsideRec.nearestSiteName === site.name && (outsideRec.distanceMeters ?? 0) > 1000);

  // Cleanup.
  await Promise.all([
    LoginGeoCheckModel.deleteMany({ userName: { $in: ["LG Sup", "LG SupNo"] } }),
    UserModel.deleteMany({ email: { $in: [sup, supNo] } }),
    ProjectSiteModel.deleteMany({ _id: { $in: [site._id, noGeoSite._id] } }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E LOGIN-GEO FAILED" : "\nE2E LOGIN-GEO PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E LOGIN-GEO ERROR:", e?.message ?? e); process.exit(1); });
