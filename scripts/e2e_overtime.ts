/* E2E for the overtime queue: HR (and Management) approve / adjust / reject OT
   on the Overtime page; PM is view-only; Supervisor is blocked. Status filters
   segment the ledger. Self-contained; cleans up. Run: npm run e2e:overtime */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { BranchModel, ProjectSiteModel, UserModel, AttendanceModel } from "../src/models";

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

  const branch = await BranchModel.create({ name: `QA OT ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA OT Site ${S}`, code: `QAOT${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });

  async function mkPending(tag: string): Promise<string> {
    const rec = await AttendanceModel.create({
      date: "2026-06-10", workerId: new Types.ObjectId(), empRegNo: `QA-OT-${S}-${tag}`, workerName: `QA OT ${tag}`,
      designationId: new Types.ObjectId(), designationName: "Carpenter",
      siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
      inTime: new Date("2026-06-10T03:30:00Z"), outTime: new Date("2026-06-10T14:30:00Z"),
      totalHours: 11, standardHours: 9, overtime: { computedHours: 2, status: "pending" },
    });
    return String(rec._id);
  }
  const id1 = await mkPending("adjust");
  const id2 = await mkPending("default");
  const id3 = await mkPending("reject");
  const id4 = await mkPending("pmblock");

  const hr = `qa-othr-${S}@trgbi.com`, pm = `qa-otpm-${S}@trgbi.com`, sup = `qa-otsup-${S}@trgbi.com`;
  await UserModel.create({ name: "QA OT HR", email: hr, passwordHash: await hashPassword(PW), role: "hr", assignedSiteIds: [], active: true });
  await UserModel.create({ name: "QA OT PM", email: pm, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [site._id], active: true });
  await UserModel.create({ name: "QA OT Sup", email: sup, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [site._id], active: true });

  const ha = await login(app, hr);
  const list = await ha.get("/overtime");
  assert("HR GET /overtime → 200", list.status === 200);
  assert("queue shows a pending record + approve control", list.text.includes(`QA-OT-${S}-adjust`) && /formaction="\/overtime\/[^"]+\/approve"/.test(list.text));
  assert("OT records grouped under their site header", list.text.includes("oh-ot-group") && list.text.includes(site.name));

  // Approve with an adjusted value.
  await ha.post(`/overtime/${id1}/approve`).type("form").send({ approvedHours: "1.5", notes: "trimmed" });
  const r1 = await AttendanceModel.findById(id1).lean();
  assert("HR approve+adjust → approved", r1?.overtime.status === "approved");
  assert("adjusted hours stored (1.5)", r1?.overtime.approvedHours === 1.5);
  assert("approvedBy recorded", !!r1?.overtime.approvedBy);

  // Approve with no value → defaults to computed (2).
  await ha.post(`/overtime/${id2}/approve`).type("form").send({});
  const r2 = await AttendanceModel.findById(id2).lean();
  assert("HR approve default → computed hours (2)", r2?.overtime.status === "approved" && r2?.overtime.approvedHours === 2);

  // Reject.
  await ha.post(`/overtime/${id3}/reject`).type("form").send({});
  const r3 = await AttendanceModel.findById(id3).lean();
  assert("HR reject → rejected, 0 approved", r3?.overtime.status === "rejected" && r3?.overtime.approvedHours === 0);

  // Filters.
  const approved = await ha.get("/overtime?status=approved");
  assert("approved filter includes adjusted record", approved.text.includes(`QA-OT-${S}-adjust`));
  assert("approved filter excludes rejected record", !approved.text.includes(`QA-OT-${S}-reject`));

  // PM is view-only.
  const pa = await login(app, pm);
  assert("PM GET /overtime → 200 (view)", (await pa.get("/overtime")).status === 200);
  const pmApprove = await pa.post(`/overtime/${id4}/approve`).type("form").send({ approvedHours: "2" });
  assert("PM approve → 403", pmApprove.status === 403);
  assert("PM could not change status", (await AttendanceModel.findById(id4).lean())?.overtime.status === "pending");

  // Supervisor is blocked entirely.
  const sa = await login(app, sup);
  assert("Supervisor GET /overtime → 403", (await sa.get("/overtime")).status === 403);

  // Cleanup.
  await Promise.all([
    AttendanceModel.deleteMany({ empRegNo: new RegExp(`^QA-OT-${S}-`) }),
    UserModel.deleteMany({ email: { $in: [hr, pm, sup] } }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E OVERTIME FAILED" : "\nE2E OVERTIME PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E OVERTIME ERROR:", e?.message ?? e); process.exit(1); });
