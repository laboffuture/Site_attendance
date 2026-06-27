/* E2E for the pre-go-live hardening pass. Covers the three behaviours changed in
   the P0/P1 fixes:
     1. Night-shift OUT fill no longer pays 0h (istOutDateTime rolls a cross-midnight
        OUT to the next day) — via the supervisor submit-fill AND the HR/Mgmt correct.
     2. Stations are site-scoped: an off-site PM/Supervisor cannot see, regenerate,
        toggle, delete, or create another site's kiosk (IDOR), but an in-scope one can.
     3. Overtime mutations are site-scoped: an off-site PM cannot recommend another
        site's OT record; an in-scope PM can.
   Self-contained; cleans up. Run: npm run e2e:hardening */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { recordScan } from "../src/lib/attendance";
import { dataUrlToBuffer } from "../src/lib/image";
import { generateStationKey, hashStationKey } from "../src/lib/stationKey";
import { istDateTime, istOutDateTime, siteLocalDate } from "../src/lib/time";
import { BranchModel, ProjectSiteModel, WorkerModel, AttendanceModel, UserModel, SiteStationModel, DesignationModel } from "../src/models";

const S = Date.now().toString(36);
const PW = "Pass123!";
const today = siteLocalDate();

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

  // ---- 0. Pure helper: the cross-midnight rollover ----
  const dRef = "2026-06-26";
  const inRef = istDateTime(dRef, "20:00");
  assert("istOutDateTime rolls a cross-midnight OUT to next day (out > in)", istOutDateTime(dRef, "05:00", inRef).getTime() > inRef.getTime());
  assert("istOutDateTime leaves a same-day OUT unchanged", istOutDateTime(dRef, "23:00", inRef).getTime() === istDateTime(dRef, "23:00").getTime());

  // ---- 0b. Pure helper: image upload validation (magic bytes + size) ----
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
  const fake = Buffer.from("this is plainly not an image").toString("base64");
  assert("dataUrlToBuffer accepts a real JPEG", dataUrlToBuffer(`data:image/jpeg;base64,${jpeg}`) !== null);
  assert("dataUrlToBuffer rejects non-image bytes mislabelled as image", dataUrlToBuffer(`data:image/jpeg;base64,${fake}`) === null);
  assert("dataUrlToBuffer rejects a non-data-url", dataUrlToBuffer("hello there") === null);

  // ---- Fixtures: one branch, two sites ----
  const branch = await BranchModel.create({ name: `QA HARD ${S}` });
  const siteA = await ProjectSiteModel.create({ branchId: branch._id, name: `QA Hard A ${S}`, code: `QAHA${S}`.toUpperCase(), lunchHours: 1 });
  const siteB = await ProjectSiteModel.create({ branchId: branch._id, name: `QA Hard B ${S}`, code: `QAHB${S}`.toUpperCase(), lunchHours: 1 });

  const mgmt = `qa-h-mgmt-${S}@trgbi.com`;
  const supA = `qa-h-supa-${S}@trgbi.com`, supB = `qa-h-supb-${S}@trgbi.com`;
  const pmA = `qa-h-pma-${S}@trgbi.com`, pmB = `qa-h-pmb-${S}@trgbi.com`;
  await UserModel.create({ name: "QA H Mgmt", email: mgmt, passwordHash: await hashPassword(PW), role: "management", assignedSiteIds: [], active: true });
  await UserModel.create({ name: "QA H SupA", email: supA, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [siteA._id], active: true });
  await UserModel.create({ name: "QA H SupB", email: supB, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [siteB._id], active: true });
  await UserModel.create({ name: "QA H PmA", email: pmA, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [siteA._id], active: true });
  await UserModel.create({ name: "QA H PmB", email: pmB, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [siteB._id], active: true });

  const nightBase = {
    date: today, siteId: siteA._id, siteName: siteA.name, branchId: branch._id, branchName: branch.name,
    designationId: new Types.ObjectId(), designationName: "Carpenter", shiftType: "night" as const, source: "scan" as const,
  };

  // ========== 1. NIGHT-SHIFT OUT FILL ==========
  // (a) Supervisor submit-fill: open night record (IN 20:00, no OUT), submit with OUT 05:00.
  const wSub = await WorkerModel.create({ empRegNo: `QA-HN1-${S}`, name: `QA Night Sub ${S}`, designationId: nightBase.designationId, designationName: "Carpenter", siteId: siteA._id, siteName: siteA.name, faceEncoding: [], status: "active" });
  const recSub = await AttendanceModel.create({ ...nightBase, workerId: wSub._id, empRegNo: wSub.empRegNo, workerName: wSub.name, inTime: istDateTime(today, "20:00"), outTime: null, attendanceStatus: "scanned" });
  const sa = await login(app, supA);
  const submit = await sa.post("/attendance/submit").type("form").send({ siteId: String(siteA._id), date: today, [`outHM_${wSub._id}`]: "05:00" });
  assert("supervisor submit redirects", submit.status === 302);
  const subDone = await AttendanceModel.findById(recSub._id).lean();
  assert("night submit-fill: OUT is after IN (rolled to next day)", !!subDone?.outTime && new Date(subDone.outTime).getTime() > new Date(subDone.inTime).getTime());
  assert("night submit-fill: hours computed (9h span, 8 std, 0 OT) — not 0", subDone?.totalHours === 9 && subDone?.standardHours === 8 && (subDone?.overtime?.computedHours ?? -1) === 0);

  // (b) HR/Management correct: open night record, correct OUT to 05:00.
  const wCorr = await WorkerModel.create({ empRegNo: `QA-HN2-${S}`, name: `QA Night Corr ${S}`, designationId: nightBase.designationId, designationName: "Carpenter", siteId: siteA._id, siteName: siteA.name, faceEncoding: [], status: "active" });
  const recCorr = await AttendanceModel.create({ ...nightBase, workerId: wCorr._id, empRegNo: wCorr.empRegNo, workerName: wCorr.name, inTime: istDateTime(today, "20:00"), outTime: null, attendanceStatus: "submitted" });
  const ma = await login(app, mgmt);
  const corr = await ma.post(`/regularization/worker/${recCorr._id}/correct`).type("form").send({ outHM: "05:00", reason: "night-shift forgotten OUT" });
  assert("management correct redirects", corr.status === 302);
  const corrDone = await AttendanceModel.findById(recCorr._id).lean();
  assert("night correct: OUT after IN (rolled)", !!corrDone?.outTime && new Date(corrDone.outTime).getTime() > new Date(corrDone.inTime).getTime());
  assert("night correct: hours computed (9h/8std/0OT) — not 0", corrDone?.totalHours === 9 && corrDone?.standardHours === 8 && (corrDone?.overtime?.computedHours ?? -1) === 0);

  // ========== 2. STATIONS IDOR ==========
  const aKey = generateStationKey();
  const stationA = await SiteStationModel.create({ projectSiteId: siteA._id, stationName: `QA Kiosk A ${S}`, stationKeyHash: hashStationKey(aKey), active: true });

  const sb = await login(app, supB); // assigned to site B only
  const sbList = await sb.get("/stations");
  assert("off-site supervisor's station list excludes site-A station", sbList.status === 200 && !sbList.text.includes(`QA Kiosk A ${S}`));

  const beforeHash = stationA.stationKeyHash;
  const regenDenied = await sb.post(`/stations/${stationA._id}/regenerate`).type("form").send({});
  assert("off-site supervisor regenerate → 403", regenDenied.status === 403);
  assert("regenerate left the key unchanged", (await SiteStationModel.findById(stationA._id).lean())!.stationKeyHash === beforeHash);

  const toggleDenied = await sb.post(`/stations/${stationA._id}/toggle`).type("form").send({});
  assert("off-site supervisor toggle → 403", toggleDenied.status === 403);
  assert("toggle left active unchanged", (await SiteStationModel.findById(stationA._id).lean())!.active === true);

  const delDenied = await sb.post(`/stations/${stationA._id}/delete`).type("form").send({});
  assert("off-site supervisor delete → 403", delDenied.status === 403);
  assert("delete did not remove the station", (await SiteStationModel.countDocuments({ _id: stationA._id })) === 1);

  const createDenied = await sb.post("/stations").type("form").send({ stationName: `QA Sneaky ${S}`, projectSiteId: String(siteA._id) });
  assert("off-site supervisor cannot create at another site (redirect, no 200 render)", createDenied.status === 302);
  assert("no station was created at site A by the off-site supervisor", (await SiteStationModel.countDocuments({ projectSiteId: siteA._id, stationName: `QA Sneaky ${S}` })) === 0);

  // In-scope supervisor (site A) CAN regenerate — and the key actually changes.
  const saStations = await login(app, supA);
  const regenOk = await saStations.post(`/stations/${stationA._id}/regenerate`).type("form").send({});
  assert("in-scope supervisor regenerate → 200 (renders new key)", regenOk.status === 200);
  assert("in-scope regenerate changed the key", (await SiteStationModel.findById(stationA._id).lean())!.stationKeyHash !== beforeHash);

  // ========== 3. OVERTIME IDOR ==========
  const wOt = await WorkerModel.create({ empRegNo: `QA-HOT-${S}`, name: `QA OT ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: siteA._id, siteName: siteA.name, faceEncoding: [], status: "active" });
  const otRec = await AttendanceModel.create({
    date: "2026-06-10", workerId: wOt._id, empRegNo: wOt.empRegNo, workerName: wOt.name,
    designationId: new Types.ObjectId(), designationName: "Carpenter",
    siteId: siteA._id, siteName: siteA.name, branchId: branch._id, branchName: branch.name,
    inTime: new Date("2026-06-10T03:30:00Z"), outTime: new Date("2026-06-10T14:30:00Z"),
    totalHours: 11, standardHours: 9, overtime: { computedHours: 2, status: "pending" },
  });

  const pb = await login(app, pmB); // assigned to site B only
  const otDenied = await pb.post(`/overtime/${otRec._id}/recommend`).type("form").send({});
  assert("off-site PM recommend → redirect (not found)", otDenied.status === 302);
  const otAfterDenied = await AttendanceModel.findById(otRec._id).lean();
  assert("off-site PM left OT untouched (pending, recommendedBy null)", otAfterDenied?.overtime.status === "pending" && !otAfterDenied?.overtime.recommendedBy);

  const pa = await login(app, pmA); // assigned to site A
  const otOk = await pa.post(`/overtime/${otRec._id}/recommend`).type("form").send({});
  assert("in-scope PM recommend → redirect", otOk.status === 302);
  const otAfterOk = await AttendanceModel.findById(otRec._id).lean();
  assert("in-scope PM moved OT to recommended", otAfterOk?.overtime.status === "recommended" && !!otAfterOk?.overtime.recommendedBy);

  // ========== 4. SCAN RE-OPEN resets a submitted day back to 'scanned' ==========
  const wRe = await WorkerModel.create({ empRegNo: `QA-HRE-${S}`, name: `QA Reopen ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: siteA._id, siteName: siteA.name, faceEncoding: [], status: "active" });
  const recRe = await AttendanceModel.create({ date: today, workerId: wRe._id, empRegNo: wRe.empRegNo, workerName: wRe.name, designationId: wRe.designationId, designationName: "Carpenter", siteId: siteA._id, siteName: siteA.name, branchId: branch._id, branchName: branch.name, inTime: istDateTime(today, "08:00"), outTime: istDateTime(today, "17:00"), totalHours: 8, standardHours: 8, attendanceStatus: "submitted", submittedBy: new Types.ObjectId(), submittedAt: new Date(), source: "scan" });
  await recordScan({ _id: wRe._id, empRegNo: wRe.empRegNo, name: wRe.name, designationId: wRe.designationId, designationName: "Carpenter" }, { _id: siteA._id, name: siteA.name, branchId: branch._id }, branch.name, "in");
  const reopened = await AttendanceModel.findById(recRe._id).lean();
  assert("re-scan IN after submit re-opens the day (OUT + hours cleared)", reopened!.outTime === null && reopened!.totalHours === null);
  assert("re-scan resets a submitted record back to 'scanned' (stamps cleared)", reopened!.attendanceStatus === "scanned" && reopened!.submittedBy === null);

  // ========== 5. DENORM PROPAGATION on site + designation rename ==========
  const desA = await DesignationModel.create({ name: `QA Mason ${S}` });
  const wRen = await WorkerModel.create({ empRegNo: `QA-HREN-${S}`, name: `QA Rename ${S}`, designationId: desA._id, designationName: desA.name, siteId: siteB._id, siteName: siteB.name, faceEncoding: [], status: "active" });
  const recRen = await AttendanceModel.create({ date: "2025-03-01", workerId: wRen._id, empRegNo: wRen.empRegNo, workerName: wRen.name, designationId: desA._id, designationName: desA.name, siteId: siteB._id, siteName: siteB.name, branchId: branch._id, branchName: branch.name, inTime: istDateTime("2025-03-01", "08:00"), outTime: istDateTime("2025-03-01", "17:00"), totalHours: 8, source: "scan" });
  // Designation rename → propagate to worker + attendance.
  const newDes = `QA Mason Senior ${S}`;
  const drn = await ma.post(`/designations/${desA._id}`).type("form").send({ name: newDes });
  assert("designation rename redirects", drn.status === 302);
  assert("designation rename propagated to the worker", (await WorkerModel.findById(wRen._id).lean())!.designationName === newDes);
  assert("designation rename propagated to attendance", (await AttendanceModel.findById(recRen._id).lean())!.designationName === newDes);
  // Site rename → propagate to primary-site workers + their attendance.
  const newSiteName = `QA Hard B Renamed ${S}`;
  const srn = await ma.post(`/org/sites/${siteB._id}`).type("form").send({ branchId: String(branch._id), name: newSiteName, code: siteB.code, standardStartTime: "09:00", standardEndTime: "18:00", latitude: "13.0", longitude: "80.0", geofenceRadiusMeters: "100" });
  assert("site rename redirects", srn.status === 302);
  assert("site rename propagated to the worker", (await WorkerModel.findById(wRen._id).lean())!.siteName === newSiteName);
  assert("site rename propagated to attendance", (await AttendanceModel.findById(recRen._id).lean())!.siteName === newSiteName);

  // ========== 6. MID-SESSION DEACTIVATION drops the live session ==========
  const dz = await login(app, supA);
  assert("active user can load the dashboard", (await dz.get("/dashboard")).status === 200);
  await UserModel.updateOne({ email: supA }, { $set: { active: false } });
  assert("deactivated user's next request is rejected (redirect to login)", (await dz.get("/dashboard")).status === 302);

  // ---- Cleanup ----
  await Promise.all([
    AttendanceModel.deleteMany({ siteId: { $in: [siteA._id, siteB._id] } }),
    WorkerModel.deleteMany({ empRegNo: new RegExp(`-${S}$`) }),
    SiteStationModel.deleteMany({ projectSiteId: { $in: [siteA._id, siteB._id] } }),
    UserModel.deleteMany({ email: { $in: [mgmt, supA, supB, pmA, pmB] } }),
    DesignationModel.deleteOne({ _id: desA._id }),
    ProjectSiteModel.deleteMany({ _id: { $in: [siteA._id, siteB._id] } }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E HARDENING FAILED" : "\nE2E HARDENING PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E HARDENING ERROR:", e?.message ?? e); process.exit(1); });
