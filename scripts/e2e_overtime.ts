/* End-to-end test for the overtime approval queue.
   Verifies approve (with adjusted hours), approve (default = computed), reject,
   status filters, and the permission matrix (PM view-only, Supervisor blocked).
   Creates pending attendance rows directly and cleans them up. Run: npm run e2e:overtime */

import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { AttendanceModel, ProjectSiteModel, UserModel } from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const S = Date.now().toString(36);
const PM_EMAIL = `qa-pm-${S}@trgbi.com`;
const SUP_EMAIL = `qa-otsup-${S}@trgbi.com`;
const PW = "Pass123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function login(app: ReturnType<typeof createApp>, email: string, password: string) {
  const agent = request.agent(app);
  const r = await agent.post("/login").type("form").send({ email, password });
  if (r.status !== 302) throw new Error(`login failed for ${email} (${r.status})`);
  return agent;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  if (!vbw) throw new Error("Seed data missing — run npm run seed.");

  async function mkPending(tag: string): Promise<string> {
    const rec = await AttendanceModel.create({
      date: "2026-06-10",
      workerId: new Types.ObjectId(),
      empRegNo: `QA-OT-${S}-${tag}`,
      workerName: `QA OT ${tag}`,
      designationId: new Types.ObjectId(),
      designationName: "Carpenter",
      siteId: vbw!._id,
      siteName: vbw!.name,
      branchId: vbw!.branchId,
      branchName: "Chennai",
      inTime: new Date("2026-06-10T03:30:00Z"),
      outTime: new Date("2026-06-10T14:30:00Z"),
      totalHours: 11,
      standardHours: 9,
      overtime: { computedHours: 2, status: "pending" },
    });
    return String(rec._id);
  }

  const id1 = await mkPending("adjust");
  const id2 = await mkPending("default");
  const id3 = await mkPending("reject");
  const id4 = await mkPending("pmblock");

  await UserModel.create({ name: "QA PM", email: PM_EMAIL, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [vbw._id], active: true });
  await UserModel.create({ name: "QA OTSup", email: SUP_EMAIL, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [vbw._id], active: true });

  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);

  const list = await admin.get("/overtime");
  assert("admin GET /overtime → 200", list.status === 200);
  assert("queue shows a pending record", list.text.includes(`QA-OT-${S}-adjust`));

  // Approve with an adjusted value.
  await admin.post(`/overtime/${id1}/approve`).type("form").send({ approvedHours: "1.5", notes: "trimmed" });
  const r1 = await AttendanceModel.findById(id1).lean();
  assert("approve+adjust → approved", r1?.overtime.status === "approved");
  assert("adjusted hours stored (1.5)", r1?.overtime.approvedHours === 1.5);
  assert("approvedBy recorded", !!r1?.overtime.approvedBy);
  assert("notes recorded", r1?.overtime.notes === "trimmed");

  // Approve with no value → defaults to computed (2).
  await admin.post(`/overtime/${id2}/approve`).type("form").send({});
  const r2 = await AttendanceModel.findById(id2).lean();
  assert("approve default → computed hours (2)", r2?.overtime.status === "approved" && r2?.overtime.approvedHours === 2);

  // Reject.
  await admin.post(`/overtime/${id3}/reject`).type("form").send({});
  const r3 = await AttendanceModel.findById(id3).lean();
  assert("reject → rejected, 0 approved", r3?.overtime.status === "rejected" && r3?.overtime.approvedHours === 0);

  // Filters.
  const approved = await admin.get("/overtime?status=approved");
  assert("approved filter includes adjusted record", approved.text.includes(`QA-OT-${S}-adjust`));
  assert("approved filter excludes rejected record", !approved.text.includes(`QA-OT-${S}-reject`));
  const pending = await admin.get("/overtime?status=pending");
  assert("pending filter excludes decided record", !pending.text.includes(`QA-OT-${S}-adjust`));

  // Permissions.
  const pm = await login(app, PM_EMAIL, PW);
  assert("PM GET /overtime → 200 (view)", (await pm.get("/overtime")).status === 200);
  const pmApprove = await pm.post(`/overtime/${id4}/approve`).type("form").send({ approvedHours: "2" });
  assert("PM approve → 403", pmApprove.status === 403);
  const r4 = await AttendanceModel.findById(id4).lean();
  assert("PM could not change status", r4?.overtime.status === "pending");

  const sup = await login(app, SUP_EMAIL, PW);
  assert("Supervisor GET /overtime → 403", (await sup.get("/overtime")).status === 403);

  // Cleanup.
  await Promise.all([
    AttendanceModel.deleteMany({ empRegNo: new RegExp(`^QA-OT-${S}-`) }),
    UserModel.deleteMany({ email: { $in: [PM_EMAIL, SUP_EMAIL] } }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E OVERTIME FAILED" : "\nE2E OVERTIME PASSED");
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error("\nE2E OVERTIME ERROR:", e?.message ?? e); process.exit(1); });
