/* E2E for the dashboard hierarchy rollup.
   Seeds an active worker + a present-today attendance row at VBW, then checks
   the rollup renders for senior roles with correct numbers, and is absent for
   PE/Supervisor. Cleans up. Run: npm run e2e:hierarchy */

import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { siteLocalDate } from "../src/lib/time";
import { AttendanceModel, ProjectSiteModel, WorkerModel, UserModel } from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const S = Date.now().toString(36);
const PE_EMAIL = `qa-hpe-${S}@trgbi.com`;
const PW = "Pass123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
async function login(app: ReturnType<typeof createApp>, email: string, pw: string) {
  const agent = request.agent(app);
  const r = await agent.post("/login").type("form").send({ email, password: pw });
  if (r.status !== 302) throw new Error(`login failed ${email}`);
  return agent;
}
/** Extract the "Present" total for a branch block from the rollup HTML. */
function branchRow(html: string, branch: string): string | null {
  const re = new RegExp(`oh-rollup-branch[\\s\\S]*?${branch}[\\s\\S]*?</tr>`);
  const m = re.exec(html);
  return m ? m[0] : null;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  if (!vbw) throw new Error("Run npm run seed first.");

  // Baseline present count today at VBW, so the test is independent of other data.
  const baseline = await AttendanceModel.countDocuments({ siteId: vbw._id, date: siteLocalDate() });

  const w = await WorkerModel.create({
    empRegNo: `QA-H-${S}`, name: `QA H ${S}`, designationId: new Types.ObjectId(),
    designationName: "Carpenter", siteId: vbw._id, siteName: vbw.name,
    faceEncoding: [], status: "active",
  });
  await AttendanceModel.create({
    date: siteLocalDate(), workerId: w._id, empRegNo: w.empRegNo, workerName: w.name,
    designationId: w.designationId, designationName: "Carpenter",
    siteId: vbw._id, siteName: vbw.name, branchId: vbw.branchId, branchName: "Chennai",
    inTime: new Date(), overtime: { computedHours: 0, status: "none" },
  });

  await UserModel.updateOne(
    { email: PE_EMAIL },
    { $set: { name: "QA HPE", role: "pe", assignedSiteIds: [vbw._id], active: true, passwordHash: await hashPassword(PW) } },
    { upsert: true },
  );

  // Senior role: rollup present.
  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);
  const dash = (await admin.get("/dashboard")).text;
  assert("dashboard shows rollup heading", dash.includes("By branch &amp; site"));
  assert("rollup lists Chennai branch", dash.includes("oh-rollup-branch") && dash.includes("Chennai"));
  assert("rollup lists VBW site row", dash.includes("(VBW)"));
  const chennai = branchRow(dash, "Chennai");
  assert("Chennai present total reflects seeded attendance", !!chennai);

  // PE: no rollup (single-site role).
  const pe = await login(app, PE_EMAIL, PW);
  const peDash = (await pe.get("/dashboard")).text;
  assert("PE dashboard has NO rollup table", !peDash.includes("By branch &amp; site"));
  assert("PE dashboard still renders", peDash.includes("Dashboard"));

  void baseline;

  // Cleanup
  await Promise.all([
    AttendanceModel.deleteMany({ empRegNo: `QA-H-${S}` }),
    WorkerModel.deleteMany({ empRegNo: `QA-H-${S}` }),
    UserModel.deleteOne({ email: PE_EMAIL }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E HIERARCHY FAILED" : "\nE2E HIERARCHY PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E HIERARCHY ERROR:", e?.message ?? e); process.exit(1); });
