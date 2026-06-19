/* End-to-end test for worker enrollment + face encoding + scope.
   Verifies: a real face photo enrolls (128-d encoding, generated empRegNo,
   denormalized names); a faceless image is rejected; site scope hides other
   sites' workers and blocks enrolling into a site you don't own.
   Creates uniquely-named test data and cleans it up. Run: npm run e2e:workers */

import fs from "fs";
import path from "path";

import request from "supertest";
import mongoose from "mongoose";
import * as jpeg from "jpeg-js";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import {
  WorkerModel,
  DesignationModel,
  ProjectSiteModel,
  UserModel,
} from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const SAMPLE = path.join(process.cwd(), "test/fixtures/face_single.jpg");

const S = Date.now().toString(36);
const WORKER = `QA Worker ${S}`;
const SNEAKY = `QA Sneaky ${S}`;
const EMPID = `EMP-${S}`.toUpperCase();
const SNEAKY_ID = `SNK-${S}`.toUpperCase();
const SUP_EMAIL = `qa-wsup-${S}@trgbi.com`;
const SUP_PW = "SupPass123!";
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

function faceDataUrl(): string {
  return "data:image/jpeg;base64," + fs.readFileSync(SAMPLE).toString("base64");
}

function blankJpegDataUrl(): string {
  const w = 64, h = 64;
  const data = Buffer.alloc(w * h * 4, 255); // solid white RGBA — no face
  const out = jpeg.encode({ data, width: w, height: h }, 90);
  return "data:image/jpeg;base64," + Buffer.from(out.data).toString("base64");
}

async function login(app: ReturnType<typeof createApp>, email: string, password: string) {
  const agent = request.agent(app);
  const r = await agent.post("/login").type("form").send({ email, password });
  if (r.status !== 302) throw new Error(`login failed for ${email} (${r.status})`);
  return agent;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) {
    console.error("Cannot run e2e: database not reachable.");
    process.exit(1);
  }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  const pvm = await ProjectSiteModel.findOne({ code: "PVM" });
  const carpenter = await DesignationModel.findOne({ name: "Carpenter" });
  if (!vbw || !pvm || !carpenter) throw new Error("Seed data missing — run npm run seed first.");

  // Supervisor scoped to PVM (a different site than where we enroll).
  await UserModel.create({
    name: "QA WSup",
    email: SUP_EMAIL,
    passwordHash: await hashPassword(SUP_PW),
    role: "supervisor",
    assignedSiteIds: [pvm._id],
    active: true,
  });

  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);

  assert("admin GET /workers → 200", (await admin.get("/workers")).status === 200);
  const form = await admin.get("/workers/new");
  assert("enroll form lists a seeded site (VBW)", form.text.includes("VBW"));

  // Enroll with a real face photo + a manual Employee ID + contact/bank fields.
  const enroll = await admin.post("/workers").type("form").send({
    empRegNo: EMPID,
    name: WORKER,
    designationId: String(carpenter._id),
    siteId: String(vbw._id),
    phone: "9000000001",
    emergencyPhone: "9000000002",
    email: "qa@trgbi.com",
    bankAccountHolder: WORKER,
    bankAccountNumber: "1234567890",
    bankIfsc: "hdfc0001234",
    bankName: "HDFC Bank",
    photoData: faceDataUrl(),
  });
  assert("enroll succeeds → redirects to /workers", enroll.status === 302 && enroll.headers.location === "/workers");

  const w = await WorkerModel.findOne({ empRegNo: EMPID });
  assert("worker created in DB", !!w);
  assert("manual empRegNo stored", w?.empRegNo === EMPID);
  assert("128-d face encoding stored", !!w && w.faceEncoding.length === 128);
  assert("designation denormalized", w?.designationName === "Carpenter");
  assert("site denormalized", w?.siteName === vbw.name);
  assert("phone + emergency stored", w?.phone === "9000000001" && w?.emergencyPhone === "9000000002");
  assert("bank details stored (IFSC uppercased)", !!w?.bank && w.bank.ifsc === "HDFC0001234");
  assert("photo file written (by _id)", !!w && fs.existsSync(path.join(UPLOAD_DIR, `${w._id}.jpg`)));

  // Duplicate Employee ID rejected.
  const beforeDup = await WorkerModel.countDocuments();
  await admin.post("/workers").type("form").send({
    empRegNo: EMPID, // same ID
    name: WORKER + " dup",
    designationId: String(carpenter._id),
    siteId: String(vbw._id),
    photoData: faceDataUrl(),
  });
  const dupForm = await admin.get("/workers/new");
  assert("duplicate Employee ID rejected", dupForm.text.includes("already exists"));
  assert("no duplicate worker persisted", (await WorkerModel.countDocuments()) === beforeDup);

  // Faceless image is rejected.
  const before = await WorkerModel.countDocuments();
  await admin.post("/workers").type("form").send({
    empRegNo: `EMP-NOFACE-${S}`,
    name: WORKER + " noface",
    designationId: String(carpenter._id),
    siteId: String(vbw._id),
    photoData: blankJpegDataUrl(),
  });
  const afterNew = await admin.get("/workers/new");
  assert("faceless image shows rejection message", afterNew.text.includes("No single clear face"));
  assert("faceless image created no worker", (await WorkerModel.countDocuments()) === before);

  // Scope: supervisor (PVM) cannot see the VBW worker, nor enroll into VBW.
  const sup = await login(app, SUP_EMAIL, SUP_PW);
  const supList = await sup.get("/workers");
  assert("supervisor list excludes other-site worker", !supList.text.includes(w!.empRegNo));
  const supForm = await sup.get("/workers/new");
  assert("supervisor enroll form shows only own site", supForm.text.includes("PVM") && !supForm.text.includes("VBW"));
  await sup.post("/workers").type("form").send({
    empRegNo: SNEAKY_ID,
    name: SNEAKY,
    designationId: String(carpenter._id),
    siteId: String(vbw._id), // not their site
    photoData: faceDataUrl(),
  });
  assert("supervisor blocked from enrolling into other site", !(await WorkerModel.findOne({ empRegNo: SNEAKY_ID })));

  // ---- #28: soft-delete requires a reason, sets deleted + a soft_delete remark ----
  const noReason = await admin.post(`/workers/${w!._id}/delete`).type("form").send({ reason: "" });
  assert("delete without a reason is rejected", noReason.status === 302);
  assert("worker still active after reasonless delete", (await WorkerModel.findById(w!._id))?.status === "active");

  await admin.post(`/workers/${w!._id}/delete`).type("form").send({ reason: "Left the project" });
  const deleted = await WorkerModel.findById(w!._id);
  assert("worker soft-deleted", deleted?.status === "deleted");
  assert("deletedAt + deletedBy recorded", !!deleted?.deletedAt && !!deleted?.deletedBy);
  assert("soft_delete remark appended with the reason",
    !!deleted && deleted.remarks.some((r) => r.type === "soft_delete" && r.text === "Left the project"));

  // ---- #28: editing a deleted worker via the main Save form is rejected ----
  const editDeleted = await admin.post(`/workers/${w!._id}`).type("form").send({
    name: "Hacked Name", siteId: String(vbw._id), designationId: String(carpenter._id), status: "active",
  });
  assert("edit-save on a deleted worker redirects (rejected)", editDeleted.status === 302);
  const stillDeleted = await WorkerModel.findById(w!._id);
  assert("deleted worker unchanged after edit attempt",
    stillDeleted?.status === "deleted" && stillDeleted?.name !== "Hacked Name" && !!stillDeleted?.deletedAt);

  // ---- #28: deleted worker hidden from the active roster, shown under Archived ----
  const activeList = await admin.get("/workers");
  assert("deleted worker hidden from active tab", !activeList.text.includes(w!.empRegNo));
  const archivedList = await admin.get("/workers?status=archived");
  assert("deleted worker shown under archived tab", archivedList.text.includes(w!.empRegNo));

  // ---- #28: restore returns a deleted worker to active ----
  await admin.post(`/workers/${w!._id}/restore`).type("form").send({});
  const restored = await WorkerModel.findById(w!._id);
  assert("restore returns worker to active", restored?.status === "active");
  assert("restore clears deletedAt", restored?.deletedAt == null);
  assert("restore appends a note remark", !!restored && restored.remarks.some((r) => r.type === "note" && /restored/i.test(r.text)));

  // ---- #28: add a remark, then clear it (struck through but retained) ----
  const remarksBefore = (await WorkerModel.findById(w!._id))!.remarks.length;
  const emptyRemark = await admin.post(`/workers/${w!._id}/remarks`).type("form").send({ text: "" });
  assert("empty remark rejected (redirect)", emptyRemark.status === 302);
  assert("empty remark not stored", (await WorkerModel.findById(w!._id))!.remarks.length === remarksBefore);

  await admin.post(`/workers/${w!._id}/remarks`).type("form").send({ text: "Spoke to site lead" });
  let wr = await WorkerModel.findById(w!._id);
  const noteIdx = wr!.remarks.findIndex((r) => r.text === "Spoke to site lead");
  assert("note remark added", noteIdx >= 0 && wr!.remarks[noteIdx].type === "note");

  await admin.post(`/workers/${w!._id}/remarks/${noteIdx}/clear`).type("form").send({});
  wr = await WorkerModel.findById(w!._id);
  assert("remark cleared but retained", !!wr && wr.remarks.length > noteIdx && wr.remarks[noteIdx].cleared === true && wr.remarks[noteIdx].text === "Spoke to site lead");

  // Cleanup.
  if (w) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, `${w._id}.jpg`)); } catch { /* ignore */ }
  }
  await Promise.all([
    WorkerModel.deleteMany({ empRegNo: { $in: [EMPID, SNEAKY_ID, `EMP-NOFACE-${S}`] } }),
    UserModel.deleteOne({ email: SUP_EMAIL }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E WORKERS FAILED" : "\nE2E WORKERS PASSED");
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error("\nE2E WORKERS ERROR:", e?.message ?? e);
  process.exit(1);
});
