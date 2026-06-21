/* E2E for the read-only overtime ledger. OT is no longer approved here — the
   daily Regularization chain subsumes it — so this verifies: the queue renders
   with status filters, carries NO approve/reject controls, the old action
   routes are gone (404), and the view/scope permissions still hold.
   Self-contained; cleans up. Run: npm run e2e:overtime */
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

  async function mkOT(tag: string, status: "pending" | "approved" | "rejected"): Promise<string> {
    const rec = await AttendanceModel.create({
      date: "2026-06-10", workerId: new Types.ObjectId(), empRegNo: `QA-OT-${S}-${tag}`, workerName: `QA OT ${tag}`,
      designationId: new Types.ObjectId(), designationName: "Carpenter",
      siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
      inTime: new Date("2026-06-10T03:30:00Z"), outTime: new Date("2026-06-10T14:30:00Z"),
      totalHours: 11, standardHours: 9, overtime: { computedHours: 2, status },
    });
    return String(rec._id);
  }
  const idPending = await mkOT("pending", "pending");
  await mkOT("approved", "approved");
  await mkOT("rejected", "rejected");

  const hr = `qa-othr-${S}@trgbi.com`, pm = `qa-otpm-${S}@trgbi.com`, sup = `qa-otsup-${S}@trgbi.com`;
  await UserModel.create({ name: "QA OT HR", email: hr, passwordHash: await hashPassword(PW), role: "hr", assignedSiteIds: [], active: true });
  await UserModel.create({ name: "QA OT PM", email: pm, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [site._id], active: true });
  await UserModel.create({ name: "QA OT Sup", email: sup, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [site._id], active: true });

  const ha = await login(app, hr);

  // Ledger renders, read-only.
  const list = await ha.get("/overtime?status=all");
  assert("HR GET /overtime → 200", list.status === 200);
  assert("ledger shows a record", list.text.includes(`QA-OT-${S}-pending`));
  assert("ledger has NO approve control", !/formaction="\/overtime\/[^"]+\/approve"/.test(list.text));
  assert("ledger has NO reject control", !/formaction="\/overtime\/[^"]+\/reject"/.test(list.text));
  assert("ledger points to regularization", list.text.includes("/regularization"));

  // Old action routes are gone.
  const gone = await ha.post(`/overtime/${idPending}/approve`).type("form").send({ approvedHours: "2" });
  assert("POST /overtime/:id/approve → 404 (route removed)", gone.status === 404);
  const goneR = await ha.post(`/overtime/${idPending}/reject`).type("form").send({});
  assert("POST /overtime/:id/reject → 404 (route removed)", goneR.status === 404);
  assert("pending record untouched", (await AttendanceModel.findById(idPending).lean())?.overtime.status === "pending");

  // Filters still segment the ledger.
  const approved = await ha.get("/overtime?status=approved");
  assert("approved filter includes approved row", approved.text.includes(`QA-OT-${S}-approved`));
  assert("approved filter excludes pending row", !approved.text.includes(`QA-OT-${S}-pending`));

  // Permissions: PM may view, Supervisor blocked.
  const pa = await login(app, pm);
  assert("PM GET /overtime → 200 (view)", (await pa.get("/overtime")).status === 200);
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
